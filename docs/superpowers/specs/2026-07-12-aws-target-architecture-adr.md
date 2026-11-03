# ADR: AWS-native target architecture for DokoKin dashboard migration

**Date:** 2026-07-12  
**Status:** Proposed  
**Scope:** `feature/aws-migration` branch, dashboard backend/runtime migration

## Context

The current migration branch moves part of authentication and some DokoKin jobs to AWS, but the production runtime is still split across:

- frontend static assets in `docs/`
- GitHub API / Gist-backed application state
- GitHub Actions as scheduler/runtime control plane
- Cloudflare Workers for proxying and heartbeat recovery
- prototype AWS Lambda + DynamoDB services under `aws-backend/`

This creates a hybrid architecture with duplicated concerns, inconsistent auth/session models, and unclear ownership of scheduling, storage, and observability.

## Decision

Adopt an **AWS-native target architecture** where AWS becomes the single backend/runtime platform for the dashboard, and GitHub is reduced to source control and CI/CD only.

### Target platform

1. **Frontend hosting**
   - Static PWA on **S3 + CloudFront**

2. **Auth**
   - **Cognito** or a real JWT issuer behind API Gateway authorizer
   - Azure identity used only for account verification/linking, not as the app session model

3. **Application API**
   - **API Gateway + Lambda**
   - Explicit resource APIs for profile, settings, schedules, timesheet, payslip, and job status

4. **Scheduling and execution**
   - **EventBridge Scheduler** for one-time and recurring schedules
   - **Lambda** job handlers for checkin, checkout, OT, timesheet, payslip, validation
   - **SQS** for buffering, retries, and failure isolation where needed

5. **Storage**
   - **DynamoDB** for user/profile/settings/schedule/job metadata
   - **S3** for larger history payloads and export-style artifacts
   - **Secrets Manager + KMS** for Azure refresh tokens and other secrets

6. **Operations**
   - **CloudWatch Logs / Metrics / Alarms**
   - **SNS** or equivalent alerting path for failures

## Consequences

### Positive

- Removes split-brain runtime between AWS and GitHub
- Eliminates GitHub Actions cron/heartbeat/watchdog as production scheduler
- Replaces blob-style `/awss/{id}` storage with explicit backend resources
- Makes auth, authorization, secrets, retries, and observability production-capable
- Gives frontend one backend contract instead of mixed localhost/Lambda/GitHub paths

### Negative

- Requires broader refactor than a simple “port Gist to DynamoDB”
- Forces contract changes across frontend modules that still depend on `/awss/{id}`
- Increases short-term migration cost because scheduling, state sync, and runtime status must all be reworked

## Current → target mapping

| Current component | Target replacement |
|---|---|
| `docs/js/app.js` session + GitHub API coupling | dedicated auth client + API client |
| `docs/js/cloud-sync.js` using `/awss/{id}` | settings/profile API backed by DynamoDB |
| `docs/js/schedule.js` + `scheduled-runs.json` | schedule API + EventBridge Scheduler |
| `docs/js/dashboard.js` reading GitHub Actions runs | job-status API backed by DynamoDB |
| `worker/` and `cloudflare-worker/heartbeat.js` | removed from runtime path |
| `aws-backend/lambda_api.py` generic auth/data prototype | split auth service + app API |
| GitHub Actions runtime workflows | AWS-native scheduled/invoked Lambdas |

## Migration notes

Recommended order:

1. Standardize auth/session and API base configuration
2. Move settings/profile sync off GitHub-backed storage
3. Move schedule CRUD and dispatch to EventBridge Scheduler
4. Move workflow/job runtime status to AWS-backed job records
5. Migrate large history payloads to DynamoDB + S3
6. Remove legacy GitHub/Gist/Cloudflare runtime dependencies

## Rejected alternatives

1. **Keep hybrid runtime long-term**
   - Rejected because it preserves duplicated control planes and confusing ownership boundaries.

2. **Port Gist blobs directly into DynamoDB without API redesign**
   - Rejected because it keeps GitHub-shaped storage and does not solve scheduler/auth/runtime coupling.

3. **Use GitHub Actions as the permanent production scheduler**
   - Rejected because cron reliability, liveness recovery, and operational visibility are weaker than AWS-native scheduling.
