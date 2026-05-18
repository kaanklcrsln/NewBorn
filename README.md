# NewBorn
<img width="918" height="336" alt="vqvqbqb" src="https://github.com/user-attachments/assets/53db5342-7606-4338-b401-450deb1ba559" />

A live GIS visualization of **where babies are being born** around the world.

Countries flash on a full-screen world map as births occur, and a glass
sidebar keeps a live leaderboard (flag · country · count).

## How it works

| Source | Used for |
| --- | --- |
| World Bank `SP.DYN.CBRT.IN` | crude birth rate (births / 1000 people / year) |
| World Bank `SP.POP.TOTL` | total population — turns the rate into absolute births/sec |
| REST Countries v3.1 | flags, country names, ISO code crosswalk (`ccn3` ↔ `cca3`) |
| world-atlas 110m TopoJSON | country polygons |

For each country, `birthsPerSecond = (crudeRate / 1000) × population / secondsPerYear`.
Every 200 ms a Poisson draw decides how many births happened; each one is
assigned to a country weighted by its rate, flashes its polygon, and bumps the
leaderboard. The world total is ~4.2 births/sec — use the **Play/Stop** and
**×60 / ×120** controls. The map is fixed (no pan/zoom); hover a country for
its name.

## Run

The page fetches from public HTTPS APIs, so serve it over `http://`
(don't open `index.html` from disk):

```powershell
# Python
python -m http.server 8080

# or Node
npx serve .
```

Then open <http://localhost:8080>.

## Files

- `index.html` — layout + CDN dependencies (Leaflet, topojson-client)
- `styles.css` — Apple-style glass sidebar and map theme
- `app.js` — data join, simulation loop, leaderboard
