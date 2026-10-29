// Thai / English for every page (admin and LIFF). The server sends codes; this file turns them into text.
// Choice is per browser (localStorage); default follows the device language, Thai for anything else Thai-ish.

const D = {
  en: {
    "app.name": "SK Duty",
    "lang.other": "ไทย",
    "nav.dashboard": "Dashboard", "nav.sheet": "Duty sheet", "nav.members": "Members & import", "nav.locations": "Locations",
    "nav.settings": "Settings", "nav.accounts": "Accounts", "nav.account": "My account",
    "act.signOut": "Sign out", "act.save": "Save", "act.cancel": "Cancel", "act.done": "Done", "act.refresh": "Refresh",
    "act.close": "Close", "act.remove": "Remove", "act.publish": "Publish", "act.review": "Review changes", "act.load": "Load",
    "common.none": "None.", "common.yes": "Yes", "common.no": "No", "common.never": "Never",

    "login.title": "Sign in", "login.username": "Username", "login.password": "Password", "login.submit": "Sign in",
    "login.needUsername": "Enter your username.", "login.needPassword": "Enter your password.",
    "login.failed.title": "Sign-in failed", "login.failed.body": "Username or password is incorrect.",
    "login.locked.title": "Account locked", "login.locked.body": "Too many failed attempts. Try again after {time}.",
    "login.rate.title": "Too many attempts", "login.rate.body": "Wait a minute and try again.",

    "account.title": "My account", "account.signedInAs": "Signed in as {name} ({username}).",
    "account.first.title": "Set your own password", "account.first.body": "You signed in with a temporary password. Choose a new one to continue.",
    "account.current": "Current password", "account.temporary": "Temporary password", "account.new": "New password",
    "account.newHelp": "At least {min} characters. A short sentence works well.", "account.again": "Repeat new password",
    "account.mismatch": "The passwords do not match.", "account.submit": "Change password",
    "account.changed.title": "Password changed", "account.changed.body": "Other signed-in sessions were signed out.",
    "account.failed": "Password not changed",

    "dash.title": "Duty dashboard", "dash.date": "Date (Bangkok)", "dash.updated": "Updated {time}",
    "dash.noRoster.title": "No roster loaded for {date}", "dash.noRoster.body": "Status is unknown, not a day off.",
    "dash.duties": "Duties", "dash.pushNote": "\"Push\" is what the LINE API accepted, not whether the member read it. \"Member status\" is what the member did.",
    "dash.noDuties": "No duties on this date.", "dash.notLinked": "LINE not linked", "dash.override": "Override",
    "dash.attemptMeta": "{time} · {dist} m · ±{acc} m · {n} attempt(s)", "dash.noAttempt": "None",
    "dash.anomalies": "Anomalies", "dash.anomaliesNote": "For review only. Nothing is rejected automatically.",
    "dash.attempts": "Check-in attempts with coordinates", "dash.showAttempts": "Show attempts",
    "dash.attemptsNote": "Raw coordinates are visible to admins only and are deleted after 90 days.",
    "dash.noAttempts": "No attempts on this date.", "dash.export": "Export", "dash.from": "From", "dash.to": "To",
    "dash.download": "Download CSV", "dash.deleted": "deleted", "dash.unknownStaff": "(unknown)",
    "kpi.total": "Duties", "kpi.checkedIn": "Checked in", "kpi.late": "Late", "kpi.pending": "Pending", "kpi.missed": "Missed",
    "kpi.rejected": "Rejected attempts",
    "col.member": "Member", "col.shift": "Shift", "col.memberStatus": "Member status", "col.lastAttempt": "Last attempt",
    "col.push": "Push", "col.kind": "Kind", "col.detail": "Detail", "col.memberIds": "Member ids", "col.time": "Time",
    "col.staff": "Staff", "col.result": "Result", "col.lat": "Latitude", "col.lng": "Longitude", "col.accuracy": "Accuracy (m)",
    "col.distance": "Distance (m)", "col.staffCode": "Staff code", "col.name": "Name", "col.group": "Group", "col.line": "LINE",
    "col.consent": "Location consent", "col.label": "Label", "col.radius": "Radius (m)", "col.username": "Username",
    "col.status": "Status", "col.lastLogin": "Last sign-in",
    "status.pending": "Pending", "status.missed": "Missed", "status.onTime": "On time {time}", "status.late": "Late {time}",
    "status.override": "Override: {note}", "status.checkedIn": "Checked in",
    "push.QUEUED": "queued", "push.LEASED": "sending", "push.RETRY_WAIT": "retrying", "push.API_ACCEPTED": "LINE accepted",
    "push.FAILED": "failed", "push.SUPPRESSED": "not needed", "push.CANCELLED": "cancelled",
    "kind.REMINDER": "reminder", "kind.PROMPT": "start", "kind.MISSED": "missed", "kind.CONFIRM": "confirmation",
    "result.ok": "ok", "result.outside_geofence": "outside geofence", "result.low_accuracy": "low accuracy",
    "result.outside_window": "outside window", "result.rejected": "rejected",
    "reason.too_early": "too early", "reason.too_late": "too late", "reason.nonce_used": "code used", "reason.nonce_expired": "code expired",
    "reason.bad_nonce": "bad code", "reason.not_your_duty": "not their duty", "reason.duty_cancelled": "duty cancelled",
    "reason.rate_limited": "too many attempts", "reason.no_consent": "no consent", "reason.bad_coords": "bad coordinates",
    "reason.invalid_token": "invalid LINE login", "reason.not_linked": "not linked", "reason.already_checked_in": "already checked in",
    "anomaly.identical_coords": "identical coordinates", "anomaly.impossible_jump": "impossible jump",
    "anomaly.repeated_low_accuracy": "repeated low accuracy", "anomaly.zero_accuracy": "zero accuracy", "anomaly.clock_skew": "phone clock off",
    "alert.scheduler_never_ran": "The scheduler has not run yet", "alert.scheduler_stale": "The scheduler last ran {minutes} min ago",
    "alert.roster_unknown_today": "No roster loaded for today ({date})", "alert.roster_unknown_tomorrow": "No roster loaded for tomorrow ({date})",
    "alert.push_failed": "{count} message(s) failed since yesterday", "alert.unlinked_on_duty": "On duty without LINE linked: {codes}",
    "override.title": "Manual check-in", "override.body": "Use this when GPS failed for a legitimate reason. The note is required and audited.",
    "override.reason": "Reason", "override.placeholder": "e.g. GPS failed indoors; seen on site by the coordinator",
    "override.late": "Record as late", "override.submit": "Check in", "override.needNote": "Enter a reason (at least 3 characters).",
    "override.failed": "Override failed",

    "sheet.title": "Duty sheet", "sheet.intro": "Tick AM / PM for each member and date, then review and publish. Dates in the range with nothing ticked are saved as \"no duty\". Members are notified automatically.",
    "sheet.from": "From", "sheet.to": "To", "sheet.location": "Location for new ticks", "sheet.noLocations": "No usable location yet. Create one with at least one geofence point on the Locations page.",
    "sheet.notLoaded": "No roster yet", "sheet.locked": "Already checked in or missed; cannot change here.",
    "sheet.otherShift": "{shift} {start}–{end} at {location} (kept)", "sheet.noMembers": "No active members yet. Add them on Members & import.",
    "sheet.review.title": "Ready to publish", "sheet.review.body": "{dates} date(s): {from} to {to}",
    "sheet.published": "Published. Messages for these dates are planned automatically.", "sheet.publishFailed": "Publish failed",
    "sheet.notAccepted": "Not accepted", "sheet.unsaved": "You have unpublished changes.",
    "sheet.selectAll": "Tick all", "sheet.clearAll": "Clear",
    "sum.new": "New duties", "sum.unchanged": "Unchanged", "sum.cancelled": "Cancelled", "sum.keptAsIs": "Kept as is",

    "members.title": "Members & import", "members.import": "Import from a file",
    "members.importIntro": "CSV or XLSX, one row per duty: date, staff_code, location_code, shift, start, end. AM and PM use the configured times; other shifts need start and end. A row with only a date marks a day with no duty. Each file replaces the pending duties of the dates it contains.",
    "members.template": "Download template", "members.chooseFile": "Choose file", "members.fileUnreadable": "File not readable",
    "members.fileRejected": "File not accepted", "members.fixRows": "Fix these rows and choose the file again.", "members.problem": "Problem",
    "members.ready": "Ready to publish batch #{id}", "members.members": "Members", "members.count": "{n} member(s). LINE link and consent status.",
    "members.code": "Staff code", "members.codeHelp": "Letters, digits, . _ -", "members.name": "Name", "members.group": "Group (optional)",
    "members.save": "Add or update", "members.saved": "Saved", "members.notSaved": "Not saved", "members.needCode": "Use 1–32 letters, digits, dots, dashes or underscores.",
    "members.needName": "Enter a name.", "members.linked": "Linked", "members.notLinked": "Not linked", "members.consentGiven": "Given",
    "members.consentNot": "Not yet", "members.linkCode": "Link code", "members.newLinkCode": "New link code", "members.none": "No members yet.",
    "members.codeTitle": "Link code for {name}", "members.codeBody": "Give this code to the member. They open the link page from the OA's welcome message and enter it.",
    "members.codeExpiry": "Works once. Expires at {time}. Issuing a new code cancels this one.", "members.noCode": "No code issued",

    "loc.title": "Locations", "loc.location": "Location", "loc.choose": "Choose a location", "loc.noneYet": "No locations yet", "loc.new": "New location",
    "loc.code": "Code", "loc.codeHelp": "Used in the roster, e.g. sk-school", "loc.name": "Name", "loc.accuracy": "Allowed GPS accuracy (m)",
    "loc.accuracyHelp": "Attempts reporting worse accuracy are rejected",
    "loc.help": "Click the map to add a geofence point and drag a marker to move it. A check-in passes inside ANY point. Start wide (100 m+) and tighten after the pilot; indoor GPS is often off by 30–80 m.",
    "loc.points": "Geofence points", "loc.noPoints": "No points yet. Click the map to add one.", "loc.labelPlaceholder": "e.g. main gate",
    "loc.save": "Save location", "loc.saved": "Location saved", "loc.savedBody": "{code} · {n} point(s)", "loc.notSaved": "Not saved",
    "loc.needPoint.title": "Add at least one point", "loc.needPoint.body": "Click the map where members check in.",

    "set.title": "Scheduling settings", "set.intro": "Applies to the whole system. Changes to times take effect for messages not yet sent; new shift times apply to duties published afterwards.",
    "set.shifts": "Shift times", "set.shiftStart": "{shift} start", "set.shiftEnd": "{shift} end",
    "set.messages": "Messages", "set.reminderTime": "Day-before reminder time", "set.reminderHelp": "Sent on the calendar day before the duty.",
    "set.missedAfter": "\"Not checked in\" message after (min)", "set.missedHelp": "Minutes after the start, only if still not checked in. 5–240.",
    "set.confirm": "Send a LINE confirmation after each check-in", "set.confirmHelp": "Costs one message per check-in from the monthly quota.",
    "set.language": "Language of LINE messages", "set.lang.th": "Thai", "set.lang.en": "English",
    "set.quiet": "Quiet hours (no messages)", "set.quietStart": "From", "set.quietEnd": "Until",
    "set.window": "Check-in window", "set.early": "Opens before start (min)", "set.earlyHelp": "0–120.",
    "set.lateAfter": "Late after start (min)", "set.lateHelp": "Check-ins later than this are marked late. 0–240.",
    "set.saved": "Settings saved", "set.savedBody": "{n} planned message(s) will be re-planned with the new times.",
    "set.notSaved": "Not saved", "set.lastChange": "Last changed {time} by {by}.", "set.defaults": "Restore defaults",
    "set.field.invalid": "Check this value.", "set.field.invalid_time": "Use HH:MM (24-hour).", "set.field.end_before_start": "End must be after start.",
    "set.field.out_of_range": "Outside the allowed range.", "set.timeHelp": "HH:MM, 24-hour",

    "acc.title": "Management accounts", "acc.intro": "Everyone with an account can manage duties, members, settings and other accounts. New accounts get a temporary password that must be changed at first sign-in.",
    "acc.new": "New account", "acc.username": "Username", "acc.usernameHelp": "3–64 letters, digits, . _ -", "acc.displayName": "Display name",
    "acc.create": "Create account", "acc.you": "You", "acc.active": "Active", "acc.disabled": "Disabled", "acc.locked": "Locked",
    "acc.mustChange": "Temporary password", "acc.reset": "Reset password", "acc.disable": "Disable", "acc.enable": "Enable",
    "acc.tempTitle": "Temporary password for {username}", "acc.tempBody": "Give this to the person privately. It is shown only once and must be changed at first sign-in.",
    "acc.confirmDisable": "Disable {username}? They are signed out now and cannot sign in until enabled.",
    "acc.confirmReset": "Reset the password of {username}? They are signed out now.", "acc.failed": "Not done",

    "liff.checkin.title": "Duty check-in", "liff.consent.title": "Location notice", "liff.consent.accept": "I understand, continue",
    "liff.noDuty": "No duty today.", "liff.window": "Check-in {from}–{to}", "liff.checkedIn": "Checked in {time}", "liff.late": "late",
    "liff.missed": "Missed", "liff.checkIn": "Check in", "liff.tryAgain": "Try again", "liff.opensAt": "Check-in opens at {time}.",
    "liff.onSite": "{shift} at {location}. Be on site, outdoors if you can.", "liff.locating": "Getting your location…", "liff.checking": "Checking…",
    "liff.notLinked.title": "Not linked yet", "liff.notLinked.body": "Your LINE account is not linked to a staff member. Open the link page from the OA's welcome message.",
    "liff.locOff.title": "Location is off", "liff.locOff.body": "Allow location for LINE in your phone settings (and turn on Precise Location), then try again.",
    "liff.noLoc.title": "No location", "liff.noLoc.body": "Move outdoors or near a window and try again.",
    "liff.far.title": "Too far from the duty point", "liff.far.body": "About {dist} m away; allowed {radius} m. Move closer and try again.",
    "liff.imprecise.title": "Location not precise enough", "liff.imprecise.body": "±{acc} m; need ±{need} m. Go outdoors, turn on Precise Location, and try again.",
    "liff.done.title": "Check-in complete", "liff.done.onTime": "On time", "liff.done.late": "Late",
    "liff.done.duty": "Duty", "liff.done.location": "Location", "liff.done.time": "Checked in at", "liff.done.distance": "Distance from the duty point",
    "liff.done.message": "A confirmation was sent to your LINE chat.", "liff.done.already": "You were already checked in for this duty.",
    "liff.done.close": "Close", "liff.done.duties": "See today's duties", "liff.error": "Error", "liff.couldNotStart": "Could not start",
    "liff.refresh": "Refresh",
    "liff.link.title": "Link your LINE account", "liff.link.intro": "Enter the one-time code from your duty coordinator. It works once and expires after 15 minutes.",
    "liff.link.code": "Code", "liff.link.submit": "Link", "liff.link.needCode": "Enter the code.", "liff.link.linking": "Linking…",
    "liff.link.done.title": "Linked as {name}", "liff.link.done.body": "Staff code {code}. Duty notices will arrive in this chat.",
    "liff.opening": "Opening…",

    "lr.too_early.t": "Not open yet", "lr.too_early.b": "Check-in for this duty has not opened.",
    "lr.too_late.t": "Closed", "lr.too_late.b": "The check-in window for this duty has closed.",
    "lr.nonce_used.t": "Try again", "lr.nonce_used.b": "This attempt was already used.",
    "lr.nonce_expired.t": "Try again", "lr.nonce_expired.b": "The page was open too long.",
    "lr.bad_nonce.t": "Try again", "lr.bad_nonce.b": "",
    "lr.not_your_duty.t": "Not your duty", "lr.not_your_duty.b": "This duty is not assigned to you.",
    "lr.duty_cancelled.t": "Cancelled", "lr.duty_cancelled.b": "This duty was cancelled.",
    "lr.rate_limited.t": "Too many attempts", "lr.rate_limited.b": "Wait a few minutes.",
    "lr.no_consent.t": "Notice not accepted", "lr.no_consent.b": "Please accept the location notice first.",
    "lr.bad_coords.t": "No usable location", "lr.bad_coords.b": "Your phone did not return a usable location.",
    "lr.line_unavailable.t": "LINE unavailable", "lr.line_unavailable.b": "Try again in a moment.",
    "lr.bad_code.t": "Code not valid", "lr.bad_code.b": "It may have expired or been used already. Ask your coordinator for a new one.",
    "lr.line_account_linked_elsewhere.t": "Already linked", "lr.line_account_linked_elsewhere.b": "This LINE account is linked to another staff member. Contact your coordinator.",

    "err.password_required": "Enter a password.", "err.password_too_short": "Use at least {min} characters.",
    "err.password_too_long": "Use at most 200 characters.", "err.password_contains_username": "The password must not contain the username.",
    "err.wrong_current_password": "The current password is wrong.", "err.same_password": "Choose a different password.",
    "err.members_required": "Add at least one member.", "err.invalid_member": "Member {index}: check the staff code and name.",
    "err.member_not_found": "Member not found or inactive.", "err.code_name_required": "Enter a code and a name.",
    "err.accuracy_out_of_range": "Accuracy must be {min}–{max} m.", "err.points_required": "Add 1–20 points.",
    "err.invalid_point": "A point has an invalid position.", "err.radius_out_of_range": "Radius must be {min}–{max} m.",
    "err.invalid_range": "Check the dates (From must not be after To).", "err.range_too_long": "Choose at most {max} days.",
    "err.invalid_date": "Check the date.", "err.note_required": "Enter a reason (3–500 characters).",
    "err.override_conflict": "This duty is cancelled or already checked in.", "err.invalid_username": "Use 3–64 letters, digits, dots, dashes or underscores.",
    "err.invalid_display_name": "Enter a display name.", "err.username_taken": "That username is taken.",
    "err.use_account_page": "Change your own password on My account.", "err.cannot_disable_self": "You cannot disable your own account.",
    "err.not_found": "Not found.", "err.cross_origin": "Request refused.", "err.rate_limited": "Too many attempts. Wait a minute.",

    "imp.rows_required": "The file has no rows.", "imp.too_many_rows": "At most {max} rows per import.",
    "imp.invalid_date": "Row {row}: invalid date \"{value}\" (use YYYY-MM-DD).", "imp.no_duty_row_not_empty": "Row {row}: a no-duty row must leave staff, location and shift empty.",
    "imp.unknown_staff": "Row {row}: unknown staff code \"{value}\".", "imp.inactive_staff": "Row {row}: staff code \"{value}\" is inactive.",
    "imp.unknown_location": "Row {row}: unknown location \"{value}\".", "imp.inactive_location": "Row {row}: location \"{value}\" is inactive.",
    "imp.location_without_points": "Row {row}: location \"{value}\" has no geofence point yet.", "imp.invalid_shift": "Row {row}: invalid shift \"{value}\".",
    "imp.shift_needs_times": "Row {row}: shift \"{value}\" is not predefined, so start and end are required.", "imp.invalid_time": "Row {row}: times must be HH:MM.",
    "imp.end_before_start": "Row {row}: end {end} must be after start {start}.", "imp.duplicate_shift": "Row {row}: {value} already has shift {shift} on {date}.",
    "imp.mixed_no_duty": "{date}: has both a no-duty row and duty rows.", "imp.overlap": "{date}: {a} overlaps {b}.",
    "imp.unknown_batch": "Unknown batch.", "imp.batch_not_staged": "This batch is already {status}.",
    "imp.resolved_change_ignored": "{date} {value}: already {status}; change ignored.", "imp.resolved_kept": "{date} {value}: {status}; kept.",
  },

  th: {
    "app.name": "SK Duty",
    "lang.other": "English",
    "nav.dashboard": "แดชบอร์ด", "nav.sheet": "ตารางเวร", "nav.members": "สมาชิกและนำเข้า", "nav.locations": "จุดเวร",
    "nav.settings": "ตั้งค่า", "nav.accounts": "บัญชีผู้ดูแล", "nav.account": "บัญชีของฉัน",
    "act.signOut": "ออกจากระบบ", "act.save": "บันทึก", "act.cancel": "ยกเลิก", "act.done": "เสร็จสิ้น", "act.refresh": "รีเฟรช",
    "act.close": "ปิด", "act.remove": "ลบ", "act.publish": "เผยแพร่", "act.review": "ตรวจสอบการเปลี่ยนแปลง", "act.load": "โหลด",
    "common.none": "ไม่มี", "common.yes": "ใช่", "common.no": "ไม่", "common.never": "ยังไม่เคย",

    "login.title": "เข้าสู่ระบบ", "login.username": "ชื่อผู้ใช้", "login.password": "รหัสผ่าน", "login.submit": "เข้าสู่ระบบ",
    "login.needUsername": "กรุณากรอกชื่อผู้ใช้", "login.needPassword": "กรุณากรอกรหัสผ่าน",
    "login.failed.title": "เข้าสู่ระบบไม่สำเร็จ", "login.failed.body": "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
    "login.locked.title": "บัญชีถูกล็อกชั่วคราว", "login.locked.body": "ใส่รหัสผ่านผิดหลายครั้งเกินไป ลองใหม่หลังเวลา {time}",
    "login.rate.title": "พยายามหลายครั้งเกินไป", "login.rate.body": "รอสักครู่แล้วลองใหม่",

    "account.title": "บัญชีของฉัน", "account.signedInAs": "เข้าสู่ระบบในชื่อ {name} ({username})",
    "account.first.title": "ตั้งรหัสผ่านของคุณเอง", "account.first.body": "คุณเข้าสู่ระบบด้วยรหัสผ่านชั่วคราว กรุณาตั้งรหัสผ่านใหม่เพื่อดำเนินการต่อ",
    "account.current": "รหัสผ่านปัจจุบัน", "account.temporary": "รหัสผ่านชั่วคราว", "account.new": "รหัสผ่านใหม่",
    "account.newHelp": "อย่างน้อย {min} ตัวอักษร ใช้เป็นประโยคสั้น ๆ ก็ได้", "account.again": "ยืนยันรหัสผ่านใหม่",
    "account.mismatch": "รหัสผ่านทั้งสองช่องไม่ตรงกัน", "account.submit": "เปลี่ยนรหัสผ่าน",
    "account.changed.title": "เปลี่ยนรหัสผ่านแล้ว", "account.changed.body": "อุปกรณ์อื่นที่เข้าสู่ระบบไว้ถูกออกจากระบบแล้ว",
    "account.failed": "ไม่ได้เปลี่ยนรหัสผ่าน",

    "dash.title": "แดชบอร์ดเวร", "dash.date": "วันที่ (เวลากรุงเทพฯ)", "dash.updated": "อัปเดต {time} น.",
    "dash.noRoster.title": "ยังไม่มีตารางเวรของวันที่ {date}", "dash.noRoster.body": "สถานะยังไม่ทราบ ไม่ได้หมายความว่าเป็นวันหยุด",
    "dash.duties": "รายการเวร", "dash.pushNote": "\"การส่งข้อความ\" คือสิ่งที่ LINE รับไปแล้ว ไม่ได้แปลว่าสมาชิกอ่านแล้ว ส่วน \"สถานะสมาชิก\" คือสิ่งที่สมาชิกทำ",
    "dash.noDuties": "ไม่มีเวรในวันนี้", "dash.notLinked": "ยังไม่เชื่อม LINE", "dash.override": "บันทึกแทน",
    "dash.attemptMeta": "{time} น. · {dist} ม. · ±{acc} ม. · {n} ครั้ง", "dash.noAttempt": "ยังไม่มี",
    "dash.anomalies": "ความผิดปกติ", "dash.anomaliesNote": "ใช้สำหรับตรวจสอบเท่านั้น ระบบไม่ได้ปฏิเสธโดยอัตโนมัติ",
    "dash.attempts": "ความพยายามเช็กอินพร้อมพิกัด", "dash.showAttempts": "แสดงรายการ",
    "dash.attemptsNote": "พิกัดดิบเห็นได้เฉพาะผู้ดูแล และจะถูกลบหลัง 90 วัน",
    "dash.noAttempts": "ไม่มีการเช็กอินในวันนี้", "dash.export": "ส่งออกข้อมูล", "dash.from": "ตั้งแต่", "dash.to": "ถึง",
    "dash.download": "ดาวน์โหลด CSV", "dash.deleted": "ลบแล้ว", "dash.unknownStaff": "(ไม่ทราบ)",
    "kpi.total": "เวรทั้งหมด", "kpi.checkedIn": "เช็กอินแล้ว", "kpi.late": "สาย", "kpi.pending": "รอเช็กอิน", "kpi.missed": "ขาด",
    "kpi.rejected": "ครั้งที่ไม่ผ่าน",
    "col.member": "สมาชิก", "col.shift": "กะ", "col.memberStatus": "สถานะสมาชิก", "col.lastAttempt": "เช็กอินล่าสุด",
    "col.push": "การส่งข้อความ", "col.kind": "ประเภท", "col.detail": "รายละเอียด", "col.memberIds": "รหัสสมาชิกในระบบ", "col.time": "เวลา",
    "col.staff": "บุคลากร", "col.result": "ผลลัพธ์", "col.lat": "ละติจูด", "col.lng": "ลองจิจูด", "col.accuracy": "ความแม่นยำ (ม.)",
    "col.distance": "ระยะทาง (ม.)", "col.staffCode": "รหัสบุคลากร", "col.name": "ชื่อ", "col.group": "กลุ่ม", "col.line": "LINE",
    "col.consent": "ยินยอมใช้ตำแหน่ง", "col.label": "ชื่อจุด", "col.radius": "รัศมี (ม.)", "col.username": "ชื่อผู้ใช้",
    "col.status": "สถานะ", "col.lastLogin": "เข้าสู่ระบบล่าสุด",
    "status.pending": "รอเช็กอิน", "status.missed": "ขาด", "status.onTime": "ตรงเวลา {time} น.", "status.late": "สาย {time} น.",
    "status.override": "ผู้ดูแลบันทึกแทน: {note}", "status.checkedIn": "เช็กอินแล้ว",
    "push.QUEUED": "รอส่ง", "push.LEASED": "กำลังส่ง", "push.RETRY_WAIT": "รอส่งซ้ำ", "push.API_ACCEPTED": "LINE รับแล้ว",
    "push.FAILED": "ส่งไม่สำเร็จ", "push.SUPPRESSED": "ไม่ต้องส่ง", "push.CANCELLED": "ยกเลิก",
    "kind.REMINDER": "แจ้งล่วงหน้า", "kind.PROMPT": "เริ่มเวร", "kind.MISSED": "ยังไม่เช็กอิน", "kind.CONFIRM": "ยืนยัน",
    "result.ok": "สำเร็จ", "result.outside_geofence": "นอกพื้นที่", "result.low_accuracy": "ตำแหน่งไม่แม่นยำ",
    "result.outside_window": "นอกช่วงเวลา", "result.rejected": "ถูกปฏิเสธ",
    "reason.too_early": "ก่อนเวลา", "reason.too_late": "หลังเวลา", "reason.nonce_used": "ใช้รหัสซ้ำ", "reason.nonce_expired": "รหัสหมดอายุ",
    "reason.bad_nonce": "รหัสไม่ถูกต้อง", "reason.not_your_duty": "ไม่ใช่เวรของตน", "reason.duty_cancelled": "เวรถูกยกเลิก",
    "reason.rate_limited": "พยายามบ่อยเกินไป", "reason.no_consent": "ยังไม่ยินยอม", "reason.bad_coords": "พิกัดไม่ถูกต้อง",
    "reason.invalid_token": "การเข้าสู่ระบบ LINE ไม่ถูกต้อง", "reason.not_linked": "ยังไม่เชื่อมบัญชี", "reason.already_checked_in": "เช็กอินไปแล้ว",
    "anomaly.identical_coords": "พิกัดซ้ำกันหลายคน", "anomaly.impossible_jump": "ตำแหน่งกระโดดผิดปกติ",
    "anomaly.repeated_low_accuracy": "ความแม่นยำต่ำซ้ำหลายครั้ง", "anomaly.zero_accuracy": "ความแม่นยำเป็นศูนย์", "anomaly.clock_skew": "เวลาในโทรศัพท์คลาดเคลื่อน",
    "alert.scheduler_never_ran": "ตัวจัดกำหนดการยังไม่เคยทำงาน", "alert.scheduler_stale": "ตัวจัดกำหนดการทำงานครั้งล่าสุดเมื่อ {minutes} นาทีที่แล้ว",
    "alert.roster_unknown_today": "ยังไม่มีตารางเวรของวันนี้ ({date})", "alert.roster_unknown_tomorrow": "ยังไม่มีตารางเวรของพรุ่งนี้ ({date})",
    "alert.push_failed": "ส่งข้อความไม่สำเร็จ {count} รายการตั้งแต่เมื่อวาน", "alert.unlinked_on_duty": "มีเวรแต่ยังไม่เชื่อม LINE: {codes}",
    "override.title": "บันทึกเช็กอินแทน", "override.body": "ใช้เมื่อ GPS ใช้งานไม่ได้ด้วยเหตุผลที่สมควร ต้องระบุเหตุผล และระบบจะบันทึกไว้ตรวจสอบ",
    "override.reason": "เหตุผล", "override.placeholder": "เช่น GPS ใช้ในอาคารไม่ได้ ผู้ดูแลเห็นว่าอยู่ที่จุดเวร",
    "override.late": "บันทึกว่าสาย", "override.submit": "บันทึกเช็กอิน", "override.needNote": "กรุณาระบุเหตุผล (อย่างน้อย 3 ตัวอักษร)",
    "override.failed": "บันทึกแทนไม่สำเร็จ",

    "sheet.title": "ตารางเวร", "sheet.intro": "ติ๊กกะเช้า (AM) / บ่าย (PM) ให้แต่ละคนในแต่ละวัน แล้วตรวจสอบและเผยแพร่ วันในช่วงที่เลือกซึ่งไม่ได้ติ๊กเลยจะถูกบันทึกเป็น \"ไม่มีเวร\" ระบบจะแจ้งเตือนสมาชิกโดยอัตโนมัติ",
    "sheet.from": "ตั้งแต่", "sheet.to": "ถึง", "sheet.location": "จุดเวรสำหรับช่องที่ติ๊กใหม่", "sheet.noLocations": "ยังไม่มีจุดเวรที่ใช้งานได้ กรุณาสร้างจุดเวรที่มีจุดพิกัดอย่างน้อยหนึ่งจุดในหน้าจุดเวร",
    "sheet.notLoaded": "ยังไม่มีตาราง", "sheet.locked": "เช็กอินแล้วหรือขาดแล้ว แก้ไขในหน้านี้ไม่ได้",
    "sheet.otherShift": "{shift} {start}–{end} น. ที่ {location} (คงไว้)", "sheet.noMembers": "ยังไม่มีสมาชิก กรุณาเพิ่มในหน้าสมาชิกและนำเข้า",
    "sheet.review.title": "พร้อมเผยแพร่", "sheet.review.body": "{dates} วัน: {from} ถึง {to}",
    "sheet.published": "เผยแพร่แล้ว ระบบจะวางแผนส่งข้อความของวันเหล่านี้โดยอัตโนมัติ", "sheet.publishFailed": "เผยแพร่ไม่สำเร็จ",
    "sheet.notAccepted": "ไม่ผ่านการตรวจสอบ", "sheet.unsaved": "มีการเปลี่ยนแปลงที่ยังไม่ได้เผยแพร่",
    "sheet.selectAll": "ติ๊กทั้งหมด", "sheet.clearAll": "ล้าง",
    "sum.new": "เวรใหม่", "sum.unchanged": "ไม่เปลี่ยนแปลง", "sum.cancelled": "ยกเลิก", "sum.keptAsIs": "คงไว้ตามเดิม",

    "members.title": "สมาชิกและนำเข้า", "members.import": "นำเข้าจากไฟล์",
    "members.importIntro": "ไฟล์ CSV หรือ XLSX หนึ่งแถวต่อหนึ่งเวร: date, staff_code, location_code, shift, start, end กะ AM และ PM ใช้เวลาที่ตั้งค่าไว้ กะอื่นต้องระบุเวลาเริ่มและสิ้นสุด แถวที่มีแต่วันที่หมายถึงวันที่ไม่มีเวร แต่ละไฟล์จะแทนที่เวรที่ยังรอเช็กอินของวันที่อยู่ในไฟล์",
    "members.template": "ดาวน์โหลดแม่แบบ", "members.chooseFile": "เลือกไฟล์", "members.fileUnreadable": "อ่านไฟล์ไม่ได้",
    "members.fileRejected": "ไฟล์ไม่ผ่านการตรวจสอบ", "members.fixRows": "แก้ไขแถวเหล่านี้แล้วเลือกไฟล์อีกครั้ง", "members.problem": "ปัญหา",
    "members.ready": "พร้อมเผยแพร่ชุดที่ #{id}", "members.members": "สมาชิก", "members.count": "{n} คน สถานะการเชื่อม LINE และการยินยอม",
    "members.code": "รหัสบุคลากร", "members.codeHelp": "ตัวอักษร ตัวเลข . _ -", "members.name": "ชื่อ", "members.group": "กลุ่ม (ไม่บังคับ)",
    "members.save": "เพิ่มหรือแก้ไข", "members.saved": "บันทึกแล้ว", "members.notSaved": "ไม่ได้บันทึก", "members.needCode": "ใช้ตัวอักษร ตัวเลข จุด ขีด หรือขีดล่าง 1–32 ตัว",
    "members.needName": "กรุณากรอกชื่อ", "members.linked": "เชื่อมแล้ว", "members.notLinked": "ยังไม่เชื่อม", "members.consentGiven": "ยินยอมแล้ว",
    "members.consentNot": "ยังไม่ยินยอม", "members.linkCode": "รหัสเชื่อมบัญชี", "members.newLinkCode": "รหัสเชื่อมใหม่", "members.none": "ยังไม่มีสมาชิก",
    "members.codeTitle": "รหัสเชื่อมบัญชีของ {name}", "members.codeBody": "ส่งรหัสนี้ให้สมาชิก ให้เปิดหน้าเชื่อมบัญชีจากข้อความต้อนรับของ OA แล้วกรอกรหัส",
    "members.codeExpiry": "ใช้ได้ครั้งเดียว หมดอายุเวลา {time} น. การออกรหัสใหม่จะยกเลิกรหัสนี้", "members.noCode": "ออกรหัสไม่สำเร็จ",

    "loc.title": "จุดเวร", "loc.location": "จุดเวร", "loc.choose": "เลือกจุดเวร", "loc.noneYet": "ยังไม่มีจุดเวร", "loc.new": "สร้างจุดเวรใหม่",
    "loc.code": "รหัส", "loc.codeHelp": "ใช้ในตารางเวร เช่น sk-school", "loc.name": "ชื่อ", "loc.accuracy": "ความแม่นยำ GPS ที่ยอมรับ (ม.)",
    "loc.accuracyHelp": "หากความแม่นยำแย่กว่านี้จะไม่ผ่าน",
    "loc.help": "คลิกบนแผนที่เพื่อเพิ่มจุดพิกัด และลากหมุดเพื่อย้าย การเช็กอินผ่านเมื่ออยู่ในรัศมีของจุดใดจุดหนึ่ง เริ่มด้วยรัศมีกว้าง (100 ม. ขึ้นไป) แล้วค่อยลดหลังทดลองใช้ GPS ในอาคารมักคลาดเคลื่อน 30–80 ม.",
    "loc.points": "จุดพิกัด", "loc.noPoints": "ยังไม่มีจุด คลิกบนแผนที่เพื่อเพิ่ม", "loc.labelPlaceholder": "เช่น ประตูหน้า",
    "loc.save": "บันทึกจุดเวร", "loc.saved": "บันทึกจุดเวรแล้ว", "loc.savedBody": "{code} · {n} จุด", "loc.notSaved": "ไม่ได้บันทึก",
    "loc.needPoint.title": "เพิ่มอย่างน้อยหนึ่งจุด", "loc.needPoint.body": "คลิกบนแผนที่ตรงที่สมาชิกจะเช็กอิน",

    "set.title": "ตั้งค่ากำหนดการ", "set.intro": "มีผลกับทั้งระบบ การเปลี่ยนเวลาจะมีผลกับข้อความที่ยังไม่ได้ส่ง ส่วนเวลากะใหม่จะใช้กับเวรที่เผยแพร่หลังจากนี้",
    "set.shifts": "เวลากะ", "set.shiftStart": "{shift} เริ่ม", "set.shiftEnd": "{shift} สิ้นสุด",
    "set.messages": "ข้อความ", "set.reminderTime": "เวลาแจ้งเตือนล่วงหน้า", "set.reminderHelp": "ส่งในวันก่อนวันเวร",
    "set.missedAfter": "ส่งข้อความ \"ยังไม่เช็กอิน\" หลังเริ่ม (นาที)", "set.missedHelp": "นับจากเวลาเริ่ม ส่งเฉพาะคนที่ยังไม่เช็กอิน 5–240 นาที",
    "set.confirm": "ส่งข้อความยืนยันทาง LINE หลังเช็กอิน", "set.confirmHelp": "ใช้โควตาข้อความรายเดือน 1 ข้อความต่อการเช็กอิน",
    "set.language": "ภาษาของข้อความ LINE", "set.lang.th": "ไทย", "set.lang.en": "อังกฤษ",
    "set.quiet": "ช่วงงดส่งข้อความ", "set.quietStart": "ตั้งแต่", "set.quietEnd": "ถึง",
    "set.window": "ช่วงเวลาเช็กอิน", "set.early": "เปิดก่อนเวลาเริ่ม (นาที)", "set.earlyHelp": "0–120 นาที",
    "set.lateAfter": "นับว่าสายหลังเริ่ม (นาที)", "set.lateHelp": "เช็กอินหลังจากนี้จะถูกบันทึกว่าสาย 0–240 นาที",
    "set.saved": "บันทึกการตั้งค่าแล้ว", "set.savedBody": "ข้อความที่วางแผนไว้ {n} รายการจะถูกวางแผนใหม่ตามเวลาใหม่",
    "set.notSaved": "ไม่ได้บันทึก", "set.lastChange": "แก้ไขล่าสุด {time} โดย {by}", "set.defaults": "คืนค่าเริ่มต้น",
    "set.field.invalid": "ตรวจสอบค่านี้อีกครั้ง", "set.field.invalid_time": "ใช้รูปแบบ ชช:นน (24 ชั่วโมง)", "set.field.end_before_start": "เวลาสิ้นสุดต้องหลังเวลาเริ่ม",
    "set.field.out_of_range": "อยู่นอกช่วงที่กำหนด", "set.timeHelp": "ชช:นน (24 ชั่วโมง)",

    "acc.title": "บัญชีผู้ดูแล", "acc.intro": "ทุกบัญชีจัดการเวร สมาชิก การตั้งค่า และบัญชีอื่นได้ บัญชีใหม่จะได้รหัสผ่านชั่วคราวที่ต้องเปลี่ยนเมื่อเข้าสู่ระบบครั้งแรก",
    "acc.new": "สร้างบัญชีใหม่", "acc.username": "ชื่อผู้ใช้", "acc.usernameHelp": "ตัวอักษร ตัวเลข . _ - จำนวน 3–64 ตัว", "acc.displayName": "ชื่อที่แสดง",
    "acc.create": "สร้างบัญชี", "acc.you": "คุณ", "acc.active": "ใช้งาน", "acc.disabled": "ปิดใช้งาน", "acc.locked": "ถูกล็อก",
    "acc.mustChange": "รหัสผ่านชั่วคราว", "acc.reset": "รีเซ็ตรหัสผ่าน", "acc.disable": "ปิดใช้งาน", "acc.enable": "เปิดใช้งาน",
    "acc.tempTitle": "รหัสผ่านชั่วคราวของ {username}", "acc.tempBody": "ส่งให้เจ้าของบัญชีเป็นการส่วนตัว รหัสนี้แสดงเพียงครั้งเดียว และต้องเปลี่ยนเมื่อเข้าสู่ระบบครั้งแรก",
    "acc.confirmDisable": "ปิดใช้งาน {username} ใช่หรือไม่ ผู้ใช้จะถูกออกจากระบบทันทีและเข้าสู่ระบบไม่ได้จนกว่าจะเปิดใช้งาน",
    "acc.confirmReset": "รีเซ็ตรหัสผ่านของ {username} ใช่หรือไม่ ผู้ใช้จะถูกออกจากระบบทันที", "acc.failed": "ดำเนินการไม่สำเร็จ",

    "liff.checkin.title": "เช็กอินเวร", "liff.consent.title": "การใช้ตำแหน่ง", "liff.consent.accept": "รับทราบ ดำเนินการต่อ",
    "liff.noDuty": "วันนี้ไม่มีเวร", "liff.window": "เช็กอินได้ {from}–{to} น.", "liff.checkedIn": "เช็กอินแล้ว {time} น.", "liff.late": "สาย",
    "liff.missed": "ขาด", "liff.checkIn": "เช็กอิน", "liff.tryAgain": "ลองอีกครั้ง", "liff.opensAt": "เปิดให้เช็กอินเวลา {time} น.",
    "liff.onSite": "เวร {shift} ที่ {location} กรุณาอยู่ที่จุดเวร และอยู่กลางแจ้งถ้าทำได้", "liff.locating": "กำลังหาตำแหน่ง…", "liff.checking": "กำลังตรวจสอบ…",
    "liff.notLinked.title": "ยังไม่ได้เชื่อมบัญชี", "liff.notLinked.body": "บัญชี LINE นี้ยังไม่ได้เชื่อมกับบุคลากร กรุณาเปิดหน้าเชื่อมบัญชีจากข้อความต้อนรับของ OA",
    "liff.locOff.title": "ตำแหน่งถูกปิดอยู่", "liff.locOff.body": "อนุญาตให้ LINE เข้าถึงตำแหน่งในการตั้งค่าโทรศัพท์ (และเปิดตำแหน่งที่แม่นยำ) แล้วลองอีกครั้ง",
    "liff.noLoc.title": "หาตำแหน่งไม่ได้", "liff.noLoc.body": "ออกไปที่โล่งหรือใกล้หน้าต่าง แล้วลองอีกครั้ง",
    "liff.far.title": "อยู่ไกลจากจุดเวรเกินไป", "liff.far.body": "ห่างประมาณ {dist} ม. (อนุญาต {radius} ม.) กรุณาเข้าใกล้แล้วลองอีกครั้ง",
    "liff.imprecise.title": "ตำแหน่งไม่แม่นยำพอ", "liff.imprecise.body": "±{acc} ม. ต้องไม่เกิน ±{need} ม. ออกไปที่โล่ง เปิดตำแหน่งที่แม่นยำ แล้วลองอีกครั้ง",
    "liff.done.title": "เช็กอินสำเร็จ", "liff.done.onTime": "ตรงเวลา", "liff.done.late": "สาย",
    "liff.done.duty": "เวร", "liff.done.location": "จุดเวร", "liff.done.time": "เวลาเช็กอิน", "liff.done.distance": "ระยะจากจุดเวร",
    "liff.done.message": "ส่งข้อความยืนยันไปที่แชต LINE ของคุณแล้ว", "liff.done.already": "คุณเช็กอินเวรนี้ไปแล้ว",
    "liff.done.close": "ปิด", "liff.done.duties": "ดูเวรวันนี้", "liff.error": "เกิดข้อผิดพลาด", "liff.couldNotStart": "เปิดหน้านี้ไม่ได้",
    "liff.refresh": "รีเฟรช",
    "liff.link.title": "เชื่อมบัญชี LINE", "liff.link.intro": "กรอกรหัสใช้ครั้งเดียวที่ได้รับจากผู้ดูแลเวร รหัสใช้ได้ครั้งเดียวและหมดอายุใน 15 นาที",
    "liff.link.code": "รหัส", "liff.link.submit": "เชื่อมบัญชี", "liff.link.needCode": "กรุณากรอกรหัส", "liff.link.linking": "กำลังเชื่อมบัญชี…",
    "liff.link.done.title": "เชื่อมบัญชีแล้ว: {name}", "liff.link.done.body": "รหัสบุคลากร {code} การแจ้งเตือนเวรจะส่งมาที่แชตนี้",
    "liff.opening": "กำลังเปิด…",

    "lr.too_early.t": "ยังไม่เปิดให้เช็กอิน", "lr.too_early.b": "ยังไม่ถึงช่วงเวลาเช็กอินของเวรนี้",
    "lr.too_late.t": "ปิดแล้ว", "lr.too_late.b": "หมดช่วงเวลาเช็กอินของเวรนี้แล้ว",
    "lr.nonce_used.t": "ลองอีกครั้ง", "lr.nonce_used.b": "การเช็กอินครั้งนี้ถูกใช้ไปแล้ว",
    "lr.nonce_expired.t": "ลองอีกครั้ง", "lr.nonce_expired.b": "เปิดหน้านี้ไว้นานเกินไป",
    "lr.bad_nonce.t": "ลองอีกครั้ง", "lr.bad_nonce.b": "",
    "lr.not_your_duty.t": "ไม่ใช่เวรของคุณ", "lr.not_your_duty.b": "เวรนี้ไม่ได้มอบหมายให้คุณ",
    "lr.duty_cancelled.t": "เวรถูกยกเลิก", "lr.duty_cancelled.b": "เวรนี้ถูกยกเลิกแล้ว",
    "lr.rate_limited.t": "พยายามบ่อยเกินไป", "lr.rate_limited.b": "รอสักครู่แล้วลองใหม่",
    "lr.no_consent.t": "ยังไม่ได้ยินยอม", "lr.no_consent.b": "กรุณารับทราบการใช้ตำแหน่งก่อน",
    "lr.bad_coords.t": "ตำแหน่งใช้ไม่ได้", "lr.bad_coords.b": "โทรศัพท์ส่งตำแหน่งที่ใช้ไม่ได้",
    "lr.line_unavailable.t": "เชื่อมต่อ LINE ไม่ได้", "lr.line_unavailable.b": "ลองใหม่อีกครั้งในอีกสักครู่",
    "lr.bad_code.t": "รหัสไม่ถูกต้อง", "lr.bad_code.b": "รหัสอาจหมดอายุหรือถูกใช้ไปแล้ว ขอรหัสใหม่จากผู้ดูแลเวร",
    "lr.line_account_linked_elsewhere.t": "เชื่อมบัญชีไว้แล้ว", "lr.line_account_linked_elsewhere.b": "บัญชี LINE นี้เชื่อมกับบุคลากรคนอื่นแล้ว กรุณาติดต่อผู้ดูแลเวร",

    "err.password_required": "กรุณากรอกรหัสผ่าน", "err.password_too_short": "ใช้อย่างน้อย {min} ตัวอักษร",
    "err.password_too_long": "ใช้ได้ไม่เกิน 200 ตัวอักษร", "err.password_contains_username": "รหัสผ่านต้องไม่มีชื่อผู้ใช้อยู่ในนั้น",
    "err.wrong_current_password": "รหัสผ่านปัจจุบันไม่ถูกต้อง", "err.same_password": "กรุณาใช้รหัสผ่านที่ต่างจากเดิม",
    "err.members_required": "เพิ่มสมาชิกอย่างน้อยหนึ่งคน", "err.invalid_member": "สมาชิกลำดับที่ {index}: ตรวจสอบรหัสและชื่อ",
    "err.member_not_found": "ไม่พบสมาชิก หรือสมาชิกไม่ได้ใช้งาน", "err.code_name_required": "กรุณากรอกรหัสและชื่อ",
    "err.accuracy_out_of_range": "ความแม่นยำต้องอยู่ระหว่าง {min}–{max} ม.", "err.points_required": "เพิ่มจุดพิกัด 1–20 จุด",
    "err.invalid_point": "มีจุดที่ตำแหน่งไม่ถูกต้อง", "err.radius_out_of_range": "รัศมีต้องอยู่ระหว่าง {min}–{max} ม.",
    "err.invalid_range": "ตรวจสอบวันที่ (วันเริ่มต้องไม่อยู่หลังวันสิ้นสุด)", "err.range_too_long": "เลือกได้ไม่เกิน {max} วัน",
    "err.invalid_date": "ตรวจสอบวันที่", "err.note_required": "กรุณาระบุเหตุผล (3–500 ตัวอักษร)",
    "err.override_conflict": "เวรนี้ถูกยกเลิกหรือเช็กอินแล้ว", "err.invalid_username": "ใช้ตัวอักษร ตัวเลข จุด ขีด หรือขีดล่าง 3–64 ตัว",
    "err.invalid_display_name": "กรุณากรอกชื่อที่แสดง", "err.username_taken": "ชื่อผู้ใช้นี้มีอยู่แล้ว",
    "err.use_account_page": "เปลี่ยนรหัสผ่านของตัวเองได้ที่หน้าบัญชีของฉัน", "err.cannot_disable_self": "ปิดใช้งานบัญชีของตัวเองไม่ได้",
    "err.not_found": "ไม่พบข้อมูล", "err.cross_origin": "คำขอถูกปฏิเสธ", "err.rate_limited": "พยายามบ่อยเกินไป รอสักครู่",

    "imp.rows_required": "ไฟล์ไม่มีข้อมูล", "imp.too_many_rows": "นำเข้าได้ไม่เกิน {max} แถวต่อครั้ง",
    "imp.invalid_date": "แถว {row}: วันที่ \"{value}\" ไม่ถูกต้อง (ใช้ ปปปป-ดด-วว)", "imp.no_duty_row_not_empty": "แถว {row}: แถวที่ไม่มีเวรต้องเว้นรหัสบุคลากร จุดเวร และกะว่างไว้",
    "imp.unknown_staff": "แถว {row}: ไม่พบรหัสบุคลากร \"{value}\"", "imp.inactive_staff": "แถว {row}: รหัสบุคลากร \"{value}\" ไม่ได้ใช้งาน",
    "imp.unknown_location": "แถว {row}: ไม่พบจุดเวร \"{value}\"", "imp.inactive_location": "แถว {row}: จุดเวร \"{value}\" ไม่ได้ใช้งาน",
    "imp.location_without_points": "แถว {row}: จุดเวร \"{value}\" ยังไม่มีจุดพิกัด", "imp.invalid_shift": "แถว {row}: กะ \"{value}\" ไม่ถูกต้อง",
    "imp.shift_needs_times": "แถว {row}: กะ \"{value}\" ไม่ได้กำหนดไว้ ต้องระบุเวลาเริ่มและสิ้นสุด", "imp.invalid_time": "แถว {row}: เวลาต้องเป็นรูปแบบ ชช:นน",
    "imp.end_before_start": "แถว {row}: เวลาสิ้นสุด {end} ต้องหลังเวลาเริ่ม {start}", "imp.duplicate_shift": "แถว {row}: {value} มีกะ {shift} ในวันที่ {date} แล้ว",
    "imp.mixed_no_duty": "{date}: มีทั้งแถวไม่มีเวรและแถวที่มีเวร", "imp.overlap": "{date}: {a} ทับซ้อนกับ {b}",
    "imp.unknown_batch": "ไม่พบชุดข้อมูล", "imp.batch_not_staged": "ชุดข้อมูลนี้ {status} แล้ว",
    "imp.resolved_change_ignored": "{date} {value}: {status} แล้ว ไม่เปลี่ยนแปลง", "imp.resolved_kept": "{date} {value}: {status} คงไว้ตามเดิม",
  },
};

const KEY = "sdn.lang";
export function lang() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  if (saved === "th" || saved === "en") return saved;
  return (navigator.language || "").toLowerCase().startsWith("en") ? "en" : "th";
}
export function setLang(l) {
  try { localStorage.setItem(KEY, l); } catch {}
  location.reload();
}

/** t("key", {param}) -> text in the current language. Missing keys warn (the UI test run watches for this). */
export function t(key, params = {}) {
  const l = lang();
  let s = D[l][key] ?? D.en[key];
  if (s === undefined) { console.warn("i18n: missing key", key); return key; }
  return s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? `{${k}}`));
}
export const has = (key) => key in D[lang()];

/** Server error {error, ...params} -> text. */
export const errText = (data) => (data?.error && has(`err.${data.error}`) ? t(`err.${data.error}`, data) : String(data?.error ?? "?"));
/** Import/sheet issue {code, ...params} -> text. */
export const issueText = (i) => (has(`imp.${i.code}`) ? t(`imp.${i.code}`, i) : JSON.stringify(i));
/** Prefix lookup with a raw fallback (statuses, results, reasons, anomaly kinds). */
export const label = (prefix, code) => (has(`${prefix}.${code}`) ? t(`${prefix}.${code}`) : String(code).replace(/_/g, " "));

/** Fill elements marked data-i18n="key" (static HTML). */
export function applyStatic(root = document) {
  document.documentElement.lang = lang();
  for (const e of root.querySelectorAll("[data-i18n]")) e.textContent = t(e.dataset.i18n);
  for (const e of root.querySelectorAll("[data-i18n-title]")) document.title = t(e.dataset.i18nTitle);
}

const locale = () => (lang() === "th" ? "th-TH" : "en-GB");
export const hhmm = (ms) => (ms == null ? "" : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" }).format(new Date(ms)));
/** "ศ. 30 ต.ค." / "Fri 30 Oct" for a 'YYYY-MM-DD' Bangkok date. */
export const dayShort = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
};
export const dateLong = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
};
export const dateTime = (ms) => (ms == null ? "" : new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(ms)));
