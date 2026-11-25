// Package invoiceclient calls StarPAY's merchant-scoped tax-invoice API.
// It never generates request IDs or retries issuance; callers persist the original
// request and keep it unchanged when recovering an uncertain response.
package invoiceclient

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const maxResponseBytes = 64 * 1024
const maxRequestBytes = 8192
const maxSafeInteger = int64(9007199254740991)

var identifier = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
var requestID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,80}$`)
var tradeNo = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var taxID = regexp.MustCompile(`^[A-Z0-9]{15,20}$`)
var invoiceID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var invoiceNumber = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ErrUncertain means the response cannot establish the original request's outcome.
// Recover with the same request ID and buyer fields; do not create another request.
var ErrUncertain = errors.New("invoice response unavailable; preserve the original request")

// Config binds one business server to one StarPAY merchant. APIID and Secret are
// the main-site merchant HMAC credentials, not an EasyPay pid/MD5 key pair.
type Config struct {
	BaseURL    string
	MerchantID string
	APIID      string
	Secret     string
	Timeout    time.Duration
	// Transport permits an explicit TLS trust configuration. Nil uses Go's
	// default transport; redirects are always disabled by this package.
	Transport http.RoundTripper
}

// Client holds a fixed merchant identity and a bounded HTTP client.
type Client struct {
	base       *url.URL
	merchantID string
	apiID      string
	secret     string
	http       *http.Client
}

// Application contains the immutable buyer input and a platform payment order ID.
// Amounts and seller tax settings are resolved by StarPAY and cannot be supplied.
type Application struct {
	RequestID string `json:"requestId"`
	TradeNo   string `json:"tradeNo"`
	BuyerType string `json:"buyerType"`
	Title     string `json:"title"`
	TaxID     string `json:"taxId"`
	Email     string `json:"email"`
}

// Invoice is a local StarPAY record. Only ISSUED with a number means a tax invoice
// has been issued; HTTP 202, PROCESSING and UNKNOWN are not successful issuance.
type Invoice struct {
	ID            string `json:"id"`
	RequestNo     string `json:"requestNo"`
	ApplicationNo string `json:"applicationNo"`
	RequestID     string `json:"requestId"`
	TradeNo       string `json:"tradeNo"`
	Title         string `json:"title"`
	AmountCents   int64  `json:"amountCents"`
	Status        string `json:"status"`
	InvoiceNo     string `json:"invoiceNo"`
	ErrorCode     string `json:"errorCode"`
	Attempt       int    `json:"attempt"`
	CreatedAt     int64  `json:"createdAt"`
	UpdatedAt     int64  `json:"updatedAt"`
}

// APIError contains a safe machine-readable API error, never the response body.
// Server failures also wrap ErrUncertain because issuance may already have happened.
type APIError struct {
	Status int
	Code   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("invoice API returned %d (%s)", e.Status, e.Code)
}

// New requires HTTPS and a complete endpoint prefix ending in a slash.
func New(config Config) (*Client, error) {
	base, err := url.Parse(config.BaseURL)
	if err != nil || !validHTTPS(base) || base.RawQuery != "" || !strings.HasSuffix(base.Path, "/") {
		return nil, errors.New("invalid invoice API base URL")
	}
	if !identifier.MatchString(config.MerchantID) || !identifier.MatchString(config.APIID) || config.Secret == "" || len(config.Secret) > 4096 {
		return nil, errors.New("merchant identity and HMAC credentials are required")
	}
	timeout := config.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	if timeout < time.Millisecond || timeout > time.Minute {
		return nil, errors.New("invoice timeout must be between 1ms and 1 minute")
	}
	return &Client{base: base, merchantID: config.MerchantID, apiID: config.APIID, secret: config.Secret,
		http: &http.Client{Timeout: timeout, Transport: config.Transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// Create sends one attempt. Repeating the exact persisted application obtains the
// same StarPAY record; this method never changes its ID or retries automatically.
func (c *Client) Create(ctx context.Context, application Application) (Invoice, error) {
	if err := validateApplication(application); err != nil {
		return Invoice{}, err
	}
	command := struct {
		Operation   string      `json:"operation"`
		MerchantID  string      `json:"merchantId"`
		Application Application `json:"application"`
	}{
		"starpay.invoice.create.v1", c.merchantID, application}
	reply, err := c.post(ctx, "applications", command)
	if err != nil {
		return Invoice{}, err
	}
	invoice := reply.Invoice
	if err = validateInvoice(invoice); err != nil {
		return Invoice{}, err
	}
	if invoice.RequestID != application.RequestID || invoice.TradeNo != application.TradeNo || invoice.Title != application.Title {
		return Invoice{}, fmt.Errorf("invoice identity mismatch: %w", ErrUncertain)
	}
	return *invoice, nil
}

// Query reads StarPAY's local record. Its background worker performs provider
// synchronization; polling here does not submit another tax invoice.
func (c *Client) Query(ctx context.Context, id string) (Invoice, error) {
	reply, err := c.invoiceCommand(ctx, "query", id)
	if err != nil {
		return Invoice{}, err
	}
	if err = validateInvoice(reply.Invoice); err != nil {
		return Invoice{}, err
	}
	if reply.Invoice.ID != id {
		return Invoice{}, fmt.Errorf("invoice identity mismatch: %w", ErrUncertain)
	}
	return *reply.Invoice, nil
}

// Files requests a fresh short-lived download URL. Do not store it as the permanent
// invoice location; StarPAY checks current issuance status before returning it.
func (c *Client) Files(ctx context.Context, id string) (string, error) {
	reply, err := c.invoiceCommand(ctx, "files", id)
	if err != nil {
		return "", err
	}
	link, err := url.Parse(reply.URL)
	if err != nil || !validHTTPS(link) || len(reply.URL) > 4096 {
		return "", errors.New("invalid invoice file URL")
	}
	return link.String(), nil
}

type replyData struct {
	MerchantID string   `json:"merchantId"`
	Invoice    *Invoice `json:"invoice"`
	URL        string   `json:"url"`
}

func (c *Client) invoiceCommand(ctx context.Context, operation, id string) (replyData, error) {
	if !invoiceID.MatchString(id) {
		return replyData{}, errors.New("invalid invoice ID")
	}
	command := struct {
		Operation  string `json:"operation"`
		MerchantID string `json:"merchantId"`
		InvoiceID  string `json:"invoiceId"`
	}{
		"starpay.invoice." + operation + ".v1", c.merchantID, id}
	return c.post(ctx, operation, command)
}

func (c *Client) post(ctx context.Context, endpoint string, command any) (replyData, error) {
	body, err := json.Marshal(command)
	if err != nil || len(body) > maxRequestBytes {
		return replyData{}, errors.New("invalid invoice command")
	}
	stamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(c.secret))
	mac.Write([]byte(stamp + "\n"))
	mac.Write(body)
	target := c.base.ResolveReference(&url.URL{Path: endpoint})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return replyData{}, errors.New("invalid invoice request")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("x-lightpay-api-id", c.apiID)
	request.Header.Set("x-lightpay-timestamp", stamp)
	request.Header.Set("x-lightpay-signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	response, err := c.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return replyData{}, fmt.Errorf("%w: %w", ErrUncertain, ctx.Err())
		}
		return replyData{}, ErrUncertain
	}
	defer response.Body.Close()
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return replyData{}, ErrUncertain
	}
	bytesRead, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(bytesRead) > maxResponseBytes || !utf8.Valid(bytesRead) {
		return replyData{}, ErrUncertain
	}
	var envelope struct {
		OK   bool      `json:"ok"`
		Code string    `json:"code"`
		Data replyData `json:"data"`
	}
	if err = json.Unmarshal(bytesRead, &envelope); err != nil {
		return replyData{}, ErrUncertain
	}
	if (response.StatusCode != 200 && response.StatusCode != 202) || !envelope.OK {
		code := envelope.Code
		if !identifier.MatchString(code) {
			code = "invoice_unavailable"
		}
		apiError := &APIError{Status: response.StatusCode, Code: code}
		if response.StatusCode >= 500 || response.StatusCode == http.StatusRequestTimeout {
			return replyData{}, errors.Join(ErrUncertain, apiError)
		}
		return replyData{}, apiError
	}
	if envelope.Data.MerchantID != c.merchantID {
		return replyData{}, fmt.Errorf("invoice merchant mismatch: %w", ErrUncertain)
	}
	if response.StatusCode == http.StatusAccepted && (endpoint != "applications" || envelope.Data.Invoice == nil ||
		(envelope.Data.Invoice.Status != "UNKNOWN" && envelope.Data.Invoice.Status != "PROCESSING")) {
		return replyData{}, fmt.Errorf("invalid pending invoice response: %w", ErrUncertain)
	}
	return envelope.Data, nil
}

func validHTTPS(link *url.URL) bool {
	return link != nil && link.Scheme == "https" && link.Hostname() != "" && link.User == nil && link.Fragment == "" && link.Opaque == ""
}

func validateApplication(application Application) error {
	if !requestID.MatchString(application.RequestID) || !tradeNo.MatchString(application.TradeNo) || !printable(application.Title, 160) {
		return errors.New("a persisted request ID, platform order and buyer title are required")
	}
	if application.BuyerType == "ORGANIZATION" {
		if !taxID.MatchString(application.TaxID) {
			return errors.New("organization buyer requires a tax ID")
		}
	} else if application.BuyerType != "INDIVIDUAL" || application.TaxID != "" {
		return errors.New("invalid buyer type or tax ID")
	}
	address, err := mail.ParseAddress(application.Email)
	if err != nil || address.Address != application.Email || len(application.Email) > 214 || strings.TrimSpace(application.Email) != application.Email {
		return errors.New("valid buyer email of at most 214 bytes is required")
	}
	_, domain, _ := strings.Cut(application.Email, "@")
	if !strings.Contains(domain, ".") || strings.HasSuffix(domain, ".") {
		return errors.New("buyer email requires a public domain")
	}
	return nil
}

func printable(value string, limit int) bool {
	if value == "" || strings.TrimSpace(value) != value || !utf8.ValidString(value) || utf8.RuneCountInString(value) > limit {
		return false
	}
	return strings.IndexFunc(value, unicode.IsControl) < 0
}

func validateInvoice(invoice *Invoice) error {
	if invoice == nil || !invoiceID.MatchString(invoice.ID) || !requestID.MatchString(invoice.RequestID) || !tradeNo.MatchString(invoice.TradeNo) ||
		invoice.AmountCents < 1 || invoice.AmountCents > maxSafeInteger || invoice.Attempt < 1 || invoice.Attempt > 5 || !printable(invoice.Title, 160) {
		return fmt.Errorf("invalid invoice record: %w", ErrUncertain)
	}
	switch invoice.Status {
	case "UNKNOWN", "PROCESSING", "FAILED":
		if invoice.InvoiceNo != "" {
			return fmt.Errorf("unissued invoice has number: %w", ErrUncertain)
		}
	case "ISSUED":
		if !invoiceNumber.MatchString(invoice.InvoiceNo) {
			return fmt.Errorf("issued invoice has no valid number: %w", ErrUncertain)
		}
	case "REVERSING", "REVERSED":
	default:
		return fmt.Errorf("invalid invoice status: %w", ErrUncertain)
	}
	return nil
}
