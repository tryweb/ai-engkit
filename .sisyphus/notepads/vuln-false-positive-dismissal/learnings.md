# Learnings - Vulnerability False Positive Dismissal

## Alert Data (2026-06-12)
- Total open alerts: 2,086
- Chrome/Chromium: 1,280 (rule ends with `-chrome`)
- X11/Xvfb: 26
- CUPS/Pixman: 8
- systemd/udev: 4
- Total FP to dismiss: 1,318
- Remaining real CVEs: 768

## API Approach
- `gh api repos/tryweb/ai-engkit/code-scanning/alerts --paginate` for fetching
- `gh api -X PATCH repos/tryweb/ai-engkit/code-scanning/alerts/{NUMBER}` for dismissal
- Sequential calls with 0.5s sleep to avoid rate limiting
