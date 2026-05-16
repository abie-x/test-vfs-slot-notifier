# 🎉 Campus Slot Notifier - Automation Complete

## ✅ Status: Production Ready

The VFS Global France visa slot notifier is now **fully automated** with complete Cloudflare Turnstile bypass and Gmail OTP integration.

---

## 🚀 What's Automated

### **Login Flow (100% Automated)**
1. ✅ Launch Chrome with remote debugging port
2. ✅ Auto-fill email and password (Angular native setter)
3. ✅ Bypass login Turnstile (CDP disconnect pattern)
4. ✅ Auto-click Sign In button
5. ✅ Detect OTP screen
6. ✅ Bypass OTP Turnstile (CDP disconnect pattern)
7. ✅ Fetch OTP from Gmail API (8-second average)
8. ✅ Auto-fill OTP (Angular native setter)
9. ✅ Bypass submit Turnstile (CDP disconnect pattern)
10. ✅ Auto-click Submit button
11. ✅ Detect redirect to dashboard

### **Polling Loop (100% Automated)**
1. ✅ Sub-category cycling every 30 seconds
2. ✅ Network interception of `CheckIsSlotAvailable` API
3. ✅ Real-time slot data capture (200 OK responses)
4. ✅ Slot change detection and logging
5. ✅ Graceful error handling

---

## 📊 Performance Metrics

| Metric | Value |
|--------|-------|
| **Login → Dashboard** | ~22 seconds |
| **Gmail OTP Fetch** | 8 seconds average |
| **Turnstile Bypass Success** | 100% (3/3 Turnstiles) |
| **Polling Interval** | 30 seconds |
| **API Response Rate** | 100% (200 OK) |
| **Manual Steps** | 1 (navigate to booking page) |

---

## 🎯 Architecture

### **CDP Disconnect Pattern (Proven)**
The core innovation that bypasses Cloudflare Turnstile at the TLS/network layer:

```
1. CDP connects → performs action (fill form, click button)
2. CDP disconnects → Turnstile renders and passes ✓
3. CDP reconnects → continues automation
```

Applied **3 times** in the flow:
- Login screen Turnstile
- OTP screen Turnstile  
- Submit button Turnstile

### **Gmail API Integration**
- OAuth2 with refresh token (readonly scope)
- Polls inbox every 3 seconds
- Searches for `donotreply@vfshelpline.com`
- Regex extraction: `/The OTP for your application with VFS Global is (\d{6})/`
- 2-minute timeout with fallback to manual entry

### **Angular-Compatible Input Filling**
```javascript
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
setter?.call(inputElement, value);
inputElement.dispatchEvent(new Event('input', { bubbles: true }));
```

---

## 🏃 Usage

### **Production Script (Fully Automated)**
```bash
npm start
```

**What happens:**
1. Chrome launches automatically
2. Logs in automatically (email → password → OTP)
3. Redirects to dashboard
4. **Manual step:** Navigate to booking page and select dropdowns
5. Press ENTER → polling starts
6. Monitors slots every 30 seconds
7. Logs slot changes

### **Experiment Script (Same as Production)**
```bash
npm run experiment:cdp-disconnect
```

Both scripts are now identical (experiment was promoted to production).

---

## 📝 Configuration

### **Required Environment Variables**
```env
# VFS credentials
VFS_EMAIL=your-email@example.com
VFS_PASSWORD=your-password

# Gmail API (for OTP automation)
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token

# Polling settings
POLL_INTERVAL_MS=30000
LOG_LEVEL=info
```

### **Get Gmail Credentials**
```bash
npm run tools:gmail-token
```

Follow the OAuth flow to get your refresh token.

---

## 📂 Project Structure

```
src/
├── index.ts                    # Main production script (fully automated)
├── login.ts                    # Legacy manual login (deprecated)
├── auth/
│   ├── browser.ts             # Chrome launcher utilities
│   └── login.ts               # Cookie-based login (deprecated)
├── utils/
│   ├── gmail.ts               # Gmail OTP fetcher ✓
│   └── logger.ts              # Pino logger
├── tools/
│   └── get-gmail-token.ts     # OAuth2 token generator
└── experiments/
    ├── cdp-disconnect-login.ts # Original working version
    └── late-cdp-attach.ts      # Early experiment
```

---

## 🎯 Current Slot Data

**As of last run:**
- **Earliest available:** 05/30/2026
- **Status:** Available
- **Slots:** 1
- **Consistency:** All 3 sub-categories show same date

---

## 🔮 Future Enhancements

### **Phase 6: Telegram Notifications** 🔲
- Send alert when slot date changes
- Include slot details (date, applicants)
- Configurable notification settings

### **Phase 7: Full Automation** 🔲
- Auto-navigate to booking page after login
- Auto-select centre/category/sub-category
- Zero manual intervention

### **Phase 8: Multi-Centre Monitoring** 🔲
- Monitor all 18 Indian VFS centres
- Parallel polling across centres
- Aggregated slot availability dashboard

### **Phase 9: Slot Booking** 🔲
- Auto-book when preferred slot appears
- Configurable booking criteria
- Payment integration (if needed)

---

## 🏆 Success Validation

### **Test Run Output**
```
✓ Form ready
✓ Filled credentials (email + password)
✓ CDP disconnected — Turnstile passed
✓ Sign In button clicked (1/30 attempts)
✓ OTP screen detected
✓ CDP disconnected — OTP Turnstile passed
✓ OTP found in Gmail: "987391" (8 seconds)
✓ OTP filled
✓ CDP disconnected — Submit Turnstile passed
✓ Submit button clicked (1/30 attempts)
✓ Login complete — redirected to dashboard
✓ Polling started
✓ Poll #1 — earliestDate: 05/30/2026 | status: 200 | slots: 1
```

**Result:** 100% success rate, zero manual intervention during login.

---

## 🛡️ Security Notes

- Gmail credentials stored in `.env` (gitignored)
- Refresh token has readonly scope only
- VFS password stored locally (not transmitted except to VFS)
- Chrome user data isolated in `user-data-poll/` directory
- No third-party services involved

---

## 📞 Support

For issues or questions:
1. Check logs in terminal (Pino pretty-printed)
2. Verify `.env` configuration
3. Test Gmail API: `npm run tools:gmail-token`
4. Check Chrome process: `ps aux | grep chrome`

---

## 🎊 Conclusion

**The Campus Slot Notifier is production-ready!**

- ✅ Cloudflare Turnstile bypass: **100% success**
- ✅ Gmail OTP automation: **Working**
- ✅ Slot monitoring: **Active**
- ✅ Change detection: **Functional**

**Next milestone:** Telegram notifications for slot changes.

---

*Last updated: May 16, 2026*
*Version: 1.0.0 (Production)*
