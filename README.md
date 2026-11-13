# Secret Santa 2026

Gift exchange app for the Christmas Event 2026 (Wed, 23 Dec). Nobody needs an account: the
organizer adds everyone's name and sends each person a private link.

- **My hints**: everyone writes three hints by 15 Nov. Only their Santa ever sees them.
- **My Santa task**: after the draw, your receiver, their hints, and where you hid the gift.
- **Hunt day**: live board (painting → approved → found). Dinner waits for the last gift.
- **Organizer**: add people and copy links, draw names, see which gifts are hidden, Santa reveal.

## How it fits together

```
public/index.html   the whole front end (static)
api/rpc.js          Vercel function: POST /api/rpc {token, action, ...}
lib/core.js         all rules and privacy checks
lib/store-*.js      Supabase store (production) and in-memory store (dev/tests)
supabase/schema.sql database tables
```

The browser only talks to `/api/rpc`. The function looks up the person from their link token
and returns only what that person may see. Organizers never get the Santa→receiver pairing,
only the hiding spot per receiver.

## Run locally

```sh
npm install
npm test          # multi-person tests
npm run dev       # http://localhost:3000/?setup  (setup key: dev, data resets on restart)
```

## Deploy (Supabase + Vercel)

1. **Supabase**: create a project. Open *SQL Editor*, paste `supabase/schema.sql`, run it.
   From *Project Settings → API*, copy the **Project URL** and the **service_role** key.
2. **GitHub**: push this folder to a private repo.
3. **Vercel**: *Add New → Project*, import the repo, framework preset **Other**. Add
   environment variables:
   - `SUPABASE_URL`: the Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: the service_role key (keep it secret)
   - `SETUP_KEY`: any long random phrase you choose

   Deploy.
4. Open `https://<your-app>.vercel.app/?setup`, enter your name and the setup key. You become
   the first organizer and land on the Organizer tab. **Bookmark the link it shows you.**
5. Click **Turn on join link**, then **Copy join link** and share it with the group. Each person
   enters their name and gets their own private link. Joining closes automatically when you draw
   names. (Or add people yourself, one name per line, and send each their **Copy link** privately.)
   Click **Make organizer** next to anyone who should help run things.
6. Optional: delete `SETUP_KEY` in Vercel and redeploy. Setup only works once anyway.

If someone loses their link, use **Copy link** again. If a link leaks, use **New link** and
the old one stops working.
