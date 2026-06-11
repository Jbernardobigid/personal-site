# social/

Staging area for Instagram media. `post-to-instagram.mjs stage <carousel-dir>` copies
rendered slides here; after commit + push, Vercel serves them publicly at
`SITE_URL/social/<id>/<file>.png`, which the Graph API requires for publishing.

Instagram downloads the media when the container is created, so folders here can be
deleted after the post is live (keeps the repo small). Do not store anything else here.
