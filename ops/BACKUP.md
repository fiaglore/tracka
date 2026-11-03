# Firestore backup and restore rehearsal (PRD-00)

The daily export is `.github/workflows/firestore-backup.yml`. It stays dormant until you do this once.

## One-time setup (Monae)
1. Upgrade the Firebase project `tracka-app-f97e1` to the Blaze plan (Firestore export needs it).
2. Create a bucket, e.g. `gs://tracka-app-f97e1-backups` (single region, ideally `europe-west1` or similar near your Firestore location).
3. Add a lifecycle rule to delete objects older than 30 days:
   ```bash
   cat > lifecycle.json <<'JSON'
   {"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}
   JSON
   gsutil lifecycle set lifecycle.json gs://tracka-app-f97e1-backups
   ```
4. Give the service account in `FIREBASE_SERVICE_ACCOUNT` the roles `Cloud Datastore Import Export Admin` and `Storage Admin` on that bucket.
5. Add the repo secret `BACKUP_BUCKET` = `gs://tracka-app-f97e1-backups`, then run the workflow once from the Actions tab.

## Restore rehearsal (do once, on a STAGING project, never production)
```bash
gcloud firestore import gs://tracka-app-f97e1-backups/<YYYY-MM-DD> --project=<staging-project-id>
```
Then sign in on a staging build and confirm a known account's data is intact. Record the date here when done: _not yet rehearsed_.
