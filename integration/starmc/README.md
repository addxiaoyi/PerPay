# StarMC payment durability integration

This directory versions the production-matched StarMC payment persistence patch separately from the PerPay application. Building or deploying PerPay does not install this overlay. Apply it only to the StarMC service after verifying the baseline hashes and the deployment steps in [overlay/README.md](overlay/README.md).

`overlay/src` contains the two reviewed replacement modules. `overlay/server-injection.json` describes the single guarded server wiring change. `overlay/manifest.json` records the expected production source and replacement hashes. The `support/src` files are the minimum unmodified source needed by the isolated tests; they are fixture support, not replacement deployment files. No production configuration, credentials, store snapshots, or remote access tools are included.

Run the integration checks from a fresh checkout with the same pinned Node release as CI:

```sh
npm ci --ignore-scripts
npm run test:starmc
```

The tests use temporary stores, fixture credentials, loopback HTTP, and child processes whose outbound requests are disabled. They cover payment acknowledgement durability, concurrent and repeated callbacks, process termination before acknowledgement, financial visibility barriers, worker continuations, and persistence conflicts. POSIX ownership and directory durability checks run on Linux and skip on Windows. The main-site Node runtime compatibility must also be checked before installation.

This verifies StarMC's ledger and persisted callback queue. A receiving merchant's own database and order fulfilment require separate acceptance against that application. These checks do not submit a live payment, refund, invoice, or notification.
