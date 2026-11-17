# Sturmie.pub Karaoke

Public song list and live request queue at https://sturmiepub.netlify.app

- `public/index.html` is the searchable song list. Singers request songs from it.
- `netlify/functions/queue.mjs` is the request queue (`/api/queue`), stored in Netlify Blobs.
- The KJ password is the `KJ_PASSWORD` environment variable in Netlify. It is never stored in this repository.

Netlify deploys automatically on every push to `main`.
