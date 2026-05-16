# Campus Slot Notifier

Automated VFS Global France visa appointment slot monitor with Cloudflare Turnstile bypass and Gmail OTP integration.

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your VFS credentials
```

### 3. Get Gmail API Credentials
```bash
npm run tools:gmail-token
```
Follow the OAuth flow and add the credentials to `.env`.

### 4. Run Production Script
```bash
npm start
```

**What happens:**
1. ✅ Chrome launches and logs in automatically
2. ✅ OTP fetched from Gmail and filled automatically
3. ✅ Redirects to dashboard
4. ⚠️ **Manual:** Navigate to booking page and select dropdowns
5. ✅ Press ENTER → automated polling starts
6. ✅ Monitors slots every 30 seconds

---

## 📋 Features

### ✅ Fully Automated
- **Login:** Email, password, Turnstile, OTP (100% automated)
- **Turnstile Bypass:** CDP disconnect pattern (3 Turnstiles bypassed)
- **Gmail OTP:** Fetches OTP automatically via Gmail API
- **Slot Monitoring:** Polls every 30 seconds via sub-category cycling
- **Change Detection:** Logs when earliest slot date changes

### 🎯 Architecture Highlights
- **CDP Disconnect Pattern:** Bypasses Cloudflare at TLS/network layer
- **Angular Native Setters:** Compatible with Angular Material forms
- **Network Interception:** Captures `CheckIsSlotAvailable` API responses
- **Robust Error Handling:** Fallback to manual entry if automation fails

---

## 📊 Performance

| Metric | Value |
|--------|-------|
| Login → Dashboard | ~22 seconds |
| Gmail OTP Fetch | 8 seconds average |
| Turnstile Success | 100% (3/3) |
| Polling Interval | 30 seconds |
| API Response Rate | 100% (200 OK) |

---

## 🛠️ Scripts

```bash
# Production (fully automated)
npm start

# Development (with auto-reload)
npm run dev

# Type checking
npm run typecheck

# Get Gmail OAuth token
npm run tools:gmail-token

# Experiments (same as production now)
npm run experiment:cdp-disconnect
npm run experiment:late-cdp
```

---

## 📝 Configuration

### Required `.env` Variables
```env
# VFS credentials
VFS_EMAIL=your-email@example.com
VFS_PASSWORD=your-password

# VFS appointment details
VFS_COUNTRY_CODE=ind
VFS_MISSION_CODE=fra
VFS_VAC_CODE=AMD
VFS_VISA_CATEGORY=TOU

# Gmail API (for OTP automation)
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token

# Polling settings
POLL_INTERVAL_MS=30000
LOG_LEVEL=info
```

---

## 🏗️ How It Works

### Login Flow (Automated)
1. Launch Chrome with `--remote-debugging-port`
2. CDP connects → navigates to login page
3. Auto-fills email and password
4. **CDP disconnects** → Login Turnstile passes ✓
5. CDP reconnects → auto-clicks Sign In
6. **CDP disconnects** → OTP Turnstile passes ✓
7. Fetches OTP from Gmail API
8. CDP reconnects → auto-fills OTP
9. **CDP disconnects** → Submit Turnstile passes ✓
10. CDP reconnects → auto-clicks Submit
11. Redirects to dashboard

### Polling Loop (Automated)
1. User navigates to booking page (manual)
2. User selects centre + category + sub-category (manual)
3. Press ENTER → CDP attaches to page
4. Network interception enabled
5. Sub-category cycling every 30s triggers API calls
6. Captures `CheckIsSlotAvailable` responses
7. Logs slot data and detects changes

---

## 🔮 Roadmap

- ✅ **Phase 1-5:** Login automation + Turnstile bypass
- ✅ **Phase 5.5:** Gmail OTP integration
- 🔲 **Phase 6:** Telegram notifications
- 🔲 **Phase 7:** Auto-navigate to booking page
- 🔲 **Phase 8:** Multi-centre monitoring (18 centres)
- 🔲 **Phase 9:** Slot booking automation

---

## 🛡️ Security

- Gmail credentials stored in `.env` (gitignored)
- Refresh token has readonly scope only
- VFS password stored locally
- Chrome user data isolated in `user-data-poll/`
- No third-party services involved

---

## 📂 Project Structure

```
src/
├── index.ts                    # Main production script ⭐
├── auth/
│   ├── browser.ts             # Chrome launcher
│   └── login.ts               # Legacy manual login
├── utils/
│   ├── gmail.ts               # Gmail OTP fetcher
│   └── logger.ts              # Pino logger
├── tools/
│   └── get-gmail-token.ts     # OAuth2 setup
└── experiments/
    ├── cdp-disconnect-login.ts # Original working version
    └── late-cdp-attach.ts      # Early experiment
```

---

## 🐛 Troubleshooting

### Gmail OTP Not Working
```bash
# Re-run OAuth flow
npm run tools:gmail-token

# Check Gmail API is enabled in Google Cloud Console
# Verify refresh token in .env
```

### Turnstile Failing
- Ensure CDP disconnects before Turnstile renders
- Check Chrome version (tested on latest)
- Verify no other automation flags are set

### Polling Not Working
- Ensure you're on the booking page
- Verify sub-category dropdown is visible
- Check Network tab for `CheckIsSlotAvailable` calls

---

## 📄 License

MIT

---

## 🙏 Acknowledgments

Built with:
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Google Gmail API](https://developers.google.com/gmail/api)
- [Pino Logger](https://getpino.io/)
- [TypeScript](https://www.typescriptlang.org/)

---

**Status:** ✅ Production Ready  
**Last Updated:** May 16, 2026  
**Version:** 1.0.0
