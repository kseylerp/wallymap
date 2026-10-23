# Earth Engine in production

The forest types layer draws Google Earth Engine pictures on the server (`lib/ee`) and serves them from our own tile
route, so the browser never sees a key. Locally it signs in with your gcloud application default credentials. In
production it needs a service account key. Without `EE_PROJECT` the layer reports itself unavailable.

## What the owner creates (once)

1. Use the Cloud project `wally-14e22`. It is already registered for noncommercial Earth Engine use and has the
   Earth Engine API on (the local credentials work against it).
2. Create a service account in that project:
   `gcloud iam service-accounts create wallymap-ee --project wally-14e22 --display-name "WallyMap Earth Engine"`
3. Give it two roles on the project:
   - `gcloud projects add-iam-policy-binding wally-14e22 --member serviceAccount:wallymap-ee@wally-14e22.iam.gserviceaccount.com --role roles/earthengine.viewer`
   - the same command with `--role roles/serviceusage.serviceUsageConsumer`
4. Register the service account for Earth Engine, if the Code Editor asks for it:
   https://code.earthengine.google.com/register (choose the project, then "service account").
5. Make a JSON key for it:
   `gcloud iam service-accounts keys create ee-key.json --iam-account wallymap-ee@wally-14e22.iam.gserviceaccount.com`
6. Add two Vercel environment variables, for both **Production** and **Preview**:
   - `EE_SERVICE_ACCOUNT_JSON`: the whole contents of `ee-key.json`, pasted as is
     (`vercel env add EE_SERVICE_ACCOUNT_JSON production < ee-key.json`, then the same for `preview`).
   - `EE_PROJECT` = `wally-14e22`.
7. Delete `ee-key.json` from your computer. Never commit it.

## Checking it

After the next deploy, this should return a PNG image:
`https://wallymap.vercel.app/api/ee/tiles/forest-types/9/421/256?view=classes&src=2020v1&conf=all`

A JSON error saying "Google Earth Engine is not set up on this server" means the key is missing or not valid JSON.
An error mentioning permission means one of the two roles is missing.

## Limits

- Tiles are cached by the CDN for 30 days, so each picture is drawn once per tile.
- Each caller may load 1,500 uncached tiles per 10 minutes (`RATE_LIMIT_EE_TILES` changes this).
- Earth Engine use is billed to `wally-14e22` through the `x-goog-user-project` header; noncommercial use is free.
