# G12++ Prep Tracker

A small dashboard for the G12++ Prep Programme. It combines the Prep App export with the Questionmark scores and shows, for each NGO:

- where learners drop off, from registration to the mock exam
- how much scores improved (mock score minus baseline score)
- which devices learners use
- what was fixed in the data, and how

**Live tool:** [add your Vercel link here]

## How it's built

Plain HTML, CSS and JavaScript. No framework, no server, no database.
Files are processed in the browser and never uploaded anywhere.

| File | What it does |
|---|---|
| `index.html` | Page layout and styles. Colours are in the `:root` block at the top. |
| `app.js` | File templates, CSV reading, data cleaning, calculations and drawing. |
| `data/` | The two sample CSV files (synthetic data from the technical test). |

## Run it locally

1. Open the folder in VS Code.
2. Install the **Live Server** extension.
3. Right-click `index.html` → **Open with Live Server**.

(Double-clicking `index.html` won't load the sample files, because browsers block that. Use the upload buttons instead.)

## Using new data

Click **Replace** on both file cards and upload new CSVs. If a file is missing a column, the tool says which one and keeps the previous data on screen. **Download template** shows the expected columns.

Real learner data should never be added to the `data/` folder, because that folder is published with the site.

## Changing things

- `CONFIG` in `app.js`: valid score range, the "stopped studying" threshold, test accounts
- `STAGES` in `app.js`: the funnel stages and how each one is counted
- `TEMPLATES` in `app.js`: the expected columns for each file

---
Built by Sally Kahil for the Alsama Project technical test, October 2026.
