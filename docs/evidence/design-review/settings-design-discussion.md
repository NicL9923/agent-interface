# 18 settings rubber duck (Opus 5.5 High, read-only)

## Recommendation: B, one small reusable ConfirmDialog for personal, model and delete

Reject A: focusing or scrolling an inline note fixes visibility but leaves three problems.
- The form stays editable while the prompt is open. Nothing clears `confirmPersonal` when Shared is re-checked (src/BotSettings.tsx:347, 467), so "Make it personal" can send `confirmPrivate` with `shared: true`.
- The prompt appears far from the Save the user just pressed. On a phone it sits under the tabs.
- The DeleteBot footer swap (src/BotSettings.tsx:638-655) stays broken. In before/web-settings-edit-delete-confirmation.png it wraps beside Save and is clipped at the bottom, and focus falls to body when the focused button unmounts.

Reject C: it replaces the content region and has to change the settled onCancel/onClose logic (src/BotSettings.tsx:269-283). That is the highest regression risk.

B matches StopConfirm (src/app/StopConfirm.tsx:7-17), the `.confirm-dialog` CSS (src/app/shell.css:126-139) and native confirmationDialog parity (ios/AgentInterface/BotSettingsView.swift:202-218). The modal makes the form inert, so the stale-confirmation class of bug goes away by construction.

## Required guards
1. **Stop React propagation of cancel and close.** React-dom only treats scroll and scrollend as target-only (node_modules/react-dom/cjs/react-dom-client.development.js:21102). Nested `cancel`/`close` therefore reach the settings Dialog's handlers. The outer onClose is protected by `dialog.current?.open` (:276). The outer onCancel (:269-273) is not: with unsaved edits, which is always true when Save prompts, it calls preventDefault on the inner Escape and opens the discard prompt. Put `event.stopPropagation()` in both handlers inside ConfirmDialog itself, so callers cannot forget it.
2. **Initial focus goes to the safe action** ("Keep editing" / "Keep assistant"), matching StopConfirm's `data-confirm-default`.
3. **Restore focus through a fallback.** The Dialog restores `previous` only when it is usable and not disabled (src/components/ui/dialog.tsx:20-22, 42-51). After "Make it personal", "Confirm this model" or "Yes, delete", Save or Delete is disabled because the request is busy. For server-triggered prompts, `previous` may already be body because Save was disabled during the fetch. Pass `fallbackFocus` = the details submit button, then `#assistant-settings-title`.
4. **No accidental writes.** `Button` already defaults to type="button" (src/components/ui/button.tsx:6), so a dialog nested in the form cannot submit. Keep it that way, and close the confirmation before or alongside the action, never after awaiting it.
5. **Model prompt carries its own warning.** Today it says "review the warning above" and relies on the error banner (:363-377). Store `cause.message` in `confirmModel: string | null` at both onError sites (:160, :184), show it as the dialog description, and return null so the banner does not duplicate it.
6. Use `role="alertdialog"` with aria-labelledby and aria-describedby. Reuse the native copy for title and actions.
7. Leave the discard prompt inline. It is already focus-managed (:114-127), sits next to the close button that triggers it, and touching it reopens settled logic.

Low risk: Chrome close-watcher grouping. The Save click increments the allowed groups, so the nested dialog gets its own group. Check Escape once in Chromium anyway.

## Tests (tests/bot-settings.test.ts)
- Existing text-based tests should mostly pass, since the dialog renders inside the container.
- Rewrite :149-161. It clicks "Other model" while the confirmation is open, which becomes impossible. New flow: Keep editing, pick another model, submit, expect `confirmModel: false`.
- Add: dispatch `cancel` then `close` on the confirm dialog with unsaved edits. Expect no discard prompt, the settings dialog still open, no write, and focus on Save.
- Add: initial focus is on Keep editing / Keep assistant.
- Add: model warning text appears inside the alertdialog.
- Add: delete focus returns to "Delete assistant" after Keep assistant.

## Capture
web-settings-edit-personal-confirmation, -delete-confirmation and a new -model-confirmation at desktop, phone, phone-dark and large-text (200%). Assert the dialog is in the top layer and fully visible, with the safe action focused.

## Hierarchy flags for this pass
- Details Save is not sticky (:497), while create-look and avatar use `sticky-actions`. On desktop 1440x1000 Save is below the fold (before/web-settings-edit-desktop.png). Add `sticky-actions` for consistency.
- Delete shares the primary action row with Save at equal visual weight. Move it to a separated trailing danger row below the form actions.
- Out of scope, flag only: the 10-tab two-row grid on desktop.
