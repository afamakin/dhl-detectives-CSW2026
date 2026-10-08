# Hosted Grand Finale Results Dashboard

This dashboard is independent of Netlify production deploys.

GitHub Actions reads the existing `dhl-detectives-csw2026` Netlify Blobs store using two GitHub repository secrets:
- `NETLIFY_SITE_ID`
- `NETLIFY_API_TOKEN`

It then publishes a static results snapshot to GitHub Pages. The workflow can be run manually and also refreshes every 15 minutes.

Do not put the Netlify token in the website or repository files.
