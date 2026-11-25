package invoiceclient

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const fixtureID = "00000000-0000-4000-8000-000000000001"
const fixtureSecret = "synthetic-server-only-merchant-secret"

func fixtureApplication() Application {
	return Application{RequestID: "business-invoice-0001", TradeNo: "native-order-1", BuyerType: "ORGANIZATION", Title: "测试购买方", TaxID: "91310000987654321B", Email: "invoice@example.test"}
}

func fixtureInvoice(status string) Invoice {
	return Invoice{ID: fixtureID, RequestID: "business-invoice-0001", TradeNo: "native-order-1", Title: "测试购买方", AmountCents: 1000, Status: status, Attempt: 1}
}

func serverClient(t *testing.T, handler http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	client, err := New(Config{BaseURL: server.URL + "/pay/epay/tax-invoices/", MerchantID: "main-1", APIID: "api-1", Secret: fixtureSecret, Timeout: time.Second, Transport: server.Client().Transport})
	if err != nil {
		t.Fatal(err)
	}
	return client, server
}

func reply(w http.ResponseWriter, status int, merchant string, invoice Invoice) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": map[string]any{"merchantId": merchant, "invoice": invoice}})
}

func TestCreateSignsExactBodyAndPreservesRequestID(t *testing.T) {
	var calls atomic.Int32
	var firstBody string
	client, _ := serverClient(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != "POST" || r.URL.Path != "/pay/epay/tax-invoices/applications" {
			t.Errorf("wrong target %s %s", r.Method, r.URL.Path)
		}
		stamp := r.Header.Get("x-lightpay-timestamp")
		mac := hmac.New(sha256.New, []byte(fixtureSecret))
		mac.Write([]byte(stamp + "\n"))
		mac.Write(body)
		if r.Header.Get("x-lightpay-signature") != "sha256="+hex.EncodeToString(mac.Sum(nil)) || r.Header.Get("x-lightpay-api-id") != "api-1" {
			t.Error("signature mismatch")
		}
		var command struct {
			Operation   string      `json:"operation"`
			MerchantID  string      `json:"merchantId"`
			Application Application `json:"application"`
		}
		if err := json.Unmarshal(body, &command); err != nil {
			t.Fatal(err)
		}
		if command.Operation != "starpay.invoice.create.v1" || command.MerchantID != "main-1" || command.Application != fixtureApplication() {
			t.Errorf("unexpected signed command: %s", body)
		}
		if calls.Add(1) == 1 {
			firstBody = string(body)
		} else if string(body) != firstBody {
			t.Error("retry changed the request")
		}
		reply(w, http.StatusAccepted, "main-1", fixtureInvoice("UNKNOWN"))
	})
	for range 2 {
		invoice, err := client.Create(context.Background(), fixtureApplication())
		if err != nil || invoice.Status != "UNKNOWN" {
			t.Fatalf("unknown must remain unresolved: %v %#v", err, invoice)
		}
	}
	if calls.Load() != 2 {
		t.Fatal("client performed an implicit retry")
	}
}

func TestQueryAndFilesUseBoundPurpose(t *testing.T) {
	client, _ := serverClient(t, func(w http.ResponseWriter, r *http.Request) {
		var command struct {
			Operation  string `json:"operation"`
			MerchantID string `json:"merchantId"`
			InvoiceID  string `json:"invoiceId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&command)
		endpoint := strings.TrimPrefix(r.URL.Path, "/pay/epay/tax-invoices/")
		if command.Operation != "starpay.invoice."+endpoint+".v1" || command.MerchantID != "main-1" || command.InvoiceID != fixtureID {
			t.Error("wrong operation or identity")
		}
		if endpoint == "files" {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"ok":true,"data":{"merchantId":"main-1","url":"https://pay.wechatpay.cn/invoicing/fapiao/fapiao-file?token=fixture"}}`)
			return
		}
		invoice := fixtureInvoice("ISSUED")
		invoice.InvoiceNo = "12345678901234567890"
		reply(w, 200, "main-1", invoice)
	})
	invoice, err := client.Query(context.Background(), fixtureID)
	if err != nil || invoice.InvoiceNo == "" {
		t.Fatalf("query: %v", err)
	}
	url, err := client.Files(context.Background(), fixtureID)
	if err != nil || !strings.HasPrefix(url, "https://pay.wechatpay.cn/") {
		t.Fatalf("files: %v", err)
	}
}

func TestRejectsMismatchedAndInvalidResponses(t *testing.T) {
	for _, scenario := range []string{"merchant", "request", "trade", "amount", "status", "issued_without_number", "accepted_issued", "trailing_json", "oversized", "html"} {
		t.Run(scenario, func(t *testing.T) {
			client, _ := serverClient(t, func(w http.ResponseWriter, r *http.Request) {
				invoice := fixtureInvoice("PROCESSING")
				merchant := "main-1"
				switch scenario {
				case "merchant":
					merchant = "other"
				case "request":
					invoice.RequestID = "other-request-0001"
				case "trade":
					invoice.TradeNo = "other-order"
				case "amount":
					invoice.AmountCents = 0
				case "status":
					invoice.Status = "PAID"
				case "issued_without_number":
					invoice.Status = "ISSUED"
				case "accepted_issued":
					invoice.Status = "ISSUED"
					invoice.InvoiceNo = "12345678901234567890"
					reply(w, http.StatusAccepted, merchant, invoice)
					return
				case "html":
					w.Header().Set("Content-Type", "text/html")
					io.WriteString(w, "<html>login</html>")
					return
				case "oversized":
					w.Header().Set("Content-Type", "application/json")
					io.WriteString(w, strings.Repeat(" ", maxResponseBytes+1))
					return
				}
				reply(w, 200, merchant, invoice)
				if scenario == "trailing_json" {
					io.WriteString(w, `{}`)
				}
			})
			_, err := client.Create(context.Background(), fixtureApplication())
			if err == nil {
				t.Fatal("accepted invalid invoice response")
			}
		})
	}
}

func TestRejectsRedirectWithoutSendingCredentials(t *testing.T) {
	var stolen atomic.Int32
	other := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { stolen.Add(1) }))
	defer other.Close()
	client, _ := serverClient(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	})
	_, err := client.Create(context.Background(), fixtureApplication())
	if err == nil || stolen.Load() != 0 {
		t.Fatal("followed redirect")
	}
}

func TestCancellationAndProviderErrorNeverRetry(t *testing.T) {
	var calls atomic.Int32
	client, _ := serverClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(409)
		io.WriteString(w, `{"ok":false,"code":"invoice_request_conflict","error":"private details"}`)
	})
	_, err := client.Create(context.Background(), fixtureApplication())
	var apiError *APIError
	if !errors.As(err, &apiError) || apiError.Code != "invoice_request_conflict" || calls.Load() != 1 || strings.Contains(err.Error(), "private details") {
		t.Fatalf("unexpected error %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = client.Create(ctx, fixtureApplication())
	if !errors.Is(err, context.Canceled) || calls.Load() != 1 {
		t.Fatalf("cancel: %v", err)
	}
}

func TestRejectsInvalidConfigAndBuyerBeforeRequest(t *testing.T) {
	for _, endpoint := range []string{"http://example.test/", "https://user:secret@example.test/", "https://example.test/no-slash", "https://example.test/?secret=x", "https://example.test/#x"} {
		if _, err := New(Config{BaseURL: endpoint, MerchantID: "main-1", APIID: "api-1", Secret: fixtureSecret}); err == nil {
			t.Errorf("accepted %s", endpoint)
		}
	}
	var calls atomic.Int32
	client, _ := serverClient(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	application := fixtureApplication()
	application.RequestID = ""
	if _, err := client.Create(context.Background(), application); err == nil {
		t.Fatal("invented missing request ID")
	}
	application = fixtureApplication()
	application.Email = "invoice@localhost"
	if _, err := client.Create(context.Background(), application); err == nil {
		t.Fatal("accepted email without a public domain")
	}
	application = fixtureApplication()
	application.BuyerType = "INDIVIDUAL"
	if _, err := client.Create(context.Background(), application); err == nil {
		t.Fatal("accepted personal tax ID")
	}
	if _, err := client.Query(context.Background(), "../files"); err == nil {
		t.Fatal("accepted invalid invoice identity")
	}
	if calls.Load() != 0 {
		t.Fatal("invalid input reached upstream")
	}
}

func TestDeadlineAndInvalidDownloadNeverRetry(t *testing.T) {
	var calls atomic.Int32
	client, server := serverClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(200 * time.Millisecond):
		}
	})
	client.http.Timeout = 20 * time.Millisecond
	_, err := client.Create(context.Background(), fixtureApplication())
	if !errors.Is(err, ErrUncertain) || calls.Load() != 1 {
		t.Fatalf("deadline must preserve uncertainty without retry: %v", err)
	}
	server.Close()
	client, _ = serverClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"ok":true,"data":{"merchantId":"main-1","url":"http://insecure.example/invoice.pdf"}}`)
	})
	if _, err = client.Files(context.Background(), fixtureID); err == nil {
		t.Fatal("accepted insecure document URL")
	}
}

func TestQueryRejectsAnotherInvoiceIdentity(t *testing.T) {
	client, _ := serverClient(t, func(w http.ResponseWriter, r *http.Request) {
		invoice := fixtureInvoice("UNKNOWN")
		invoice.ID = "00000000-0000-4000-8000-000000000002"
		reply(w, 200, "main-1", invoice)
	})
	if _, err := client.Query(context.Background(), fixtureID); !errors.Is(err, ErrUncertain) {
		t.Fatalf("accepted another invoice: %v", err)
	}
}

func TestServerFailurePreservesUncertaintyAndAPIError(t *testing.T) {
	var calls atomic.Int32
	client, _ := serverClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		io.WriteString(w, `{"ok":false,"code":"invoice_unavailable"}`)
	})
	_, err := client.Create(context.Background(), fixtureApplication())
	var apiError *APIError
	if !errors.Is(err, ErrUncertain) || !errors.As(err, &apiError) || apiError.Status != 503 || calls.Load() != 1 {
		t.Fatalf("server failure may follow issuance and must not retry: %v", err)
	}
}
