# AGENTS.md

## Text Encoding

- Open `.md` files as UTF-8 by default.
- If a Markdown file is not readable as UTF-8, check its actual encoding instead of skipping it.

## Version Control

- This project should be managed with both Git and jj.
- Register commits, jj changes, or equivalent version-control checkpoints at appropriate points during future work.
- Do not revert user changes unless the user explicitly requests it.

## Completion Notification

When the task ends, decide whether the user's goal was achieved.

If the task ends unsuccessfully or incompletely, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\budou\.codex\my-sound-tools\codex-failure-sound.ps1" Failure
```

Otherwise, run:

```powershell
powershell -NoProfile -Command "[console]::beep(880,250); Start-Sleep -Milliseconds 100; [console]::beep(880,250)"
```
