# Self-Hosted Turborepo Remote Cache (GCP Cloud Run + GCS)

Kvitbit provisions a self-hosted [`ducktors/turborepo-remote-cache`](https://github.com/ducktors/turborepo-remote-cache) service on Cloud Run backed by a dedicated GCS bucket (`kvitbit-prod-turbo-cache-prod`) in `europe-west3` with a 30-day object TTL lifecycle policy and a least-privilege service account (`kvitbit-prod-turbo-cache`).

## One-time production enablement

1. Set the repository variable `KVITBIT_ENABLE_TURBO_CACHE=true` in GitHub Settings -> Secrets and variables -> Actions -> Variables.
2. Run the **Deploy Kvitbit (GCP Alchemy)** workflow with `bootstrap_turbo_cache_secret=true` to create the empty Secret Manager container `kvitbit-prod-turbo-cache-token`.
3. Generate a strong bearer token and add it to Secret Manager and GitHub Actions:
   ```bash
   token="$(openssl rand -hex 32)"
   printf '%s' "$token" | gcloud secrets versions add kvitbit-prod-turbo-cache-token \
     --project kvitbit-prod --data-file=-
   gh secret set TURBO_TOKEN --body "$token"
   ```
4. Run a normal **Deploy Kvitbit (GCP Alchemy)** deploy. Copy the `kvitbit-prod-turbo-cache` Cloud Run URL and save it as GitHub Actions variables:
   ```bash
   url="$(gcloud run services describe kvitbit-prod-turbo-cache \
     --project kvitbit-prod --region europe-west3 --format='value(status.url)')"
   gh variable set TURBO_API --body "$url"
   gh variable set TURBO_TEAM --body "team_kvitbit"
   ```

## Local developer setup

Export the same three variables in your shell (or `.env.local`, gitignored):

```bash
export TURBO_API="https://kvitbit-prod-turbo-cache-<hash>-ey.a.run.app"
export TURBO_TEAM="team_kvitbit"
export TURBO_TOKEN="<same bearer token from Secret Manager>"
```

When `TURBO_API` / `TURBO_TOKEN` are unset (for example on external fork PRs or offline), Turborepo automatically falls back to local `.turbo/cache`.

## Blacksmith runners

GitHub Actions workflows run on Blacksmith runners, whose built-in Turborepo cache is runner-local only (not reachable from developer machines). Keeping `TURBO_API`, `TURBO_TEAM`, and `TURBO_TOKEN` set in CI workflows makes Blacksmith defer to this shared Cloud Run remote cache so local `turbo` and CI share one cache.
