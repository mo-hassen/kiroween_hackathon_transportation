# Admin web app (not created yet)

The staff console is a separate Flutter web app. It is created in **Phase 5**, together with
the document review workflow that verification officers need
(see `docs/architecture/13-implementation-plan.md`).

It will:

- talk only to `/api/v1/admin/*` with staff tokens (password + TOTP),
- share models and formatters through `packages/core_shared`,
- be deployed to its own origin, which is the only browser origin allowed by API CORS.

Admin code never ships inside the driver/owner Android app.
