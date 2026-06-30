# Profile Switch for Azure AD Token Bundle — Design

**Date:** 2026-06-30  
**Scope:** Settings page, Azure AD Token area, profile switching for bundled runtime settings.

## 1. Goal

Add a **Profile Switch** feature in Settings so user can switch between predefined work profiles that include:

1. Azure re-auth identity target
2. Default location
3. Workflow schedule set
4. OT profile
5. Notification preferences

Feature must support both:

1. Manual switch by user action
2. Auto-switch by weekday/time rules (JST)

## 2. Architecture

Use **reference-based profiles** (approved approach A):

- Profile object stores references/keys, not full snapshots of all blobs.
- Schedule data stays in per-profile schedule-set files.
- Active profile pointer is separate from profile definitions.

### 2.1 Data storage

1. `profiles.json` (Gist): profile metadata + reference mapping.
2. `profile-schedules/<profile_id>.json` (Gist): schedule set per profile.
3. `wf_dash_active_profile` (local + CloudSync key): active profile pointer.
4. `profile-switch-log` (local): recent switch audit events.

### 2.2 Core operation

`switchProfile(profileId)`:

1. Validate target profile and referenced assets.
2. Apply referenced bundle to runtime/UI.
3. Persist active pointer.
4. Emit audit log entry.

No full-state copy during switch.

## 3. UX Flow

### 3.1 Manual switch

In Settings (under Azure AD Token card):

1. Profile selector
2. `Activate` button
3. Confirmation modal with short diff summary (location/schedule/notif/OT)

After success:

- Refresh affected views: Dashboard, Schedule, OT, Settings.

### 3.2 Auto-switch

Add auto-switch rules:

- `weekday + time range -> profile_id`

Engine behavior:

1. Evaluate when app becomes active and on focus/showDashboard path.
2. Apply only when target profile differs from current profile.
3. Priority: specific rule > default rule.
4. Tie-break: newest rule wins.

## 4. Safety and Error Handling

1. Missing reference (e.g., missing `schedule_set_id`): block activation with explicit error.
2. User is editing Schedule/OT form when auto-switch fires: defer switch and show pending banner.
3. Gist write failure: rollback active pointer to previous profile and record error in audit.
4. Add cooldown 60s to prevent rapid profile flips.

## 5. Acceptance Criteria

1. Manual switch updates all 5 bundle components in one operation and reflects in UI within ~1s.
2. Auto-switch follows JST rule windows and does not oscillate due to cooldown.
3. Profile switch does not corrupt schedule metadata (`last_run`, `skip_dates`) of profile schedule sets.
4. Active profile persists across reload; cross-device state converges via CloudSync.
5. Audit log records timestamp, source (`manual`/`auto`), from-profile, to-profile, result.

## 6. Out of Scope (this phase)

1. Multi-user authorization model
2. Per-profile secret vault encryption changes
3. Server-side scheduler behavior changes outside existing dispatch model
