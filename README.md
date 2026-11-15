# Secret Santa 2026

Gift exchange app for the Christmas Event 2026 (Wed, 23 Dec). Nobody needs an account: the
organizer adds everyone's name and sends each person a private link.

- **My wishlist**: everyone writes three wishlist items by Wed 18 Nov, 11:59 PM. Only their
  Santa sees them, and only next to a number, never a name.
- **Numbers**: the draw (Thu 19 Nov) gives everyone a random gift number. Your Santa sees
  "#N + wishlist"; you see "You are #M", so on hunt day you look for the gift labelled #M.
- **My Santa task**: buy a gift (RM50+), label it with your receiver's number, hide it in the
  office by Mon 21 Dec, and write clues for them plus the exact spot (organizers only).
- **Hunt day** (Wed 23 Dec): clues unlock at 00:00 MYT. Live board of names and "Found it".
  Dinner waits for the last gift.
- **TV board**: `/?tv=CODE`, a read-only board for a shared screen (names and found only).
- **Organizer**: add people and copy links, join link, TV link, draw, gift readiness by number.

## How it fits together

```
public/index.html   the whole front end (static)
api/rpc.js          Vercel function: POST /api/rpc {token, action, ...}
lib/core.js         all rules and privacy checks
lib/store-*.js      Supabase store (production) and in-memory store (dev/tests)
supabase/schema.sql database tables
```

The browser only talks to `/api/rpc`. The function looks up the person from their link token
and returns only what that person may see:

- Nobody ever gets the Santa→receiver pairing, organizers included.
- A Santa gets their receiver's number and wishlist, never a name or id.
- Before the hunt starts, organizers see gift readiness by number only (clues written? spot
  written?). From hunt start they also see each number's name, clues and exact spot.
- The hunt board and TV board show names and found status, never numbers.

The hunt start is enforced by the server, from `HUNT_START` (default
`2026-12-23T00:00:00+08:00`).

## Run locally

```sh
npm install
npm test          # multi-person tests
npm run dev       # http://localhost:3000/?setup  (setup key: dev, data resets on restart)
HUNT_START=2020-01-01 npm run dev   # preview hunt day
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
   - `HUNT_START` (optional): when clues unlock, ISO time. Defaults to `2026-12-23T00:00:00+08:00`.

   Deploy.
4. Open `https://<your-app>.vercel.app/?setup`, enter your name and the setup key. You become
   the first organizer and land on the Organizer tab. **Bookmark the link it shows you.**
5. Click **Turn on join link**, then **Copy join link** and share it with the group. Each person
   enters their name and gets their own private link. Joining closes automatically when you draw
   names. (Or add people yourself, one name per line, and send each their **Copy link** privately.)
   Click **Make organizer** next to anyone who should help run things.
6. Optional: delete `SETUP_KEY` in Vercel and redeploy. Setup only works once anyway.

For the hunt, click **Turn on** under TV link in the Organizer tab and open the copied
`/?tv=...` link on the office screen. **New** replaces the link; **Turn off** disables it.

### Upgrading a database made with an older schema.sql

The draw now stores a gift number and hides store clues. If your tables already exist, run the
migration your maintainer gave you (adds `draw.number`, `hides.clues`, and updates
`replace_draw`) before deploying this version. A fresh install just runs `schema.sql`.

If someone loses their link, use **Copy link** again. If a link leaks, use **New link** and
the old one stops working.
