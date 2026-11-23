# November 22 iOS full-suite opt-in

Source fingerprint: `sha256:a3afb674539eb0ded80034df12e0a0ca2307fb5572fca0bc2f11a6a1b175ba7b`.

The new rejection test failed on the original wrapper. The fake Xcode ran even when the
command omitted a selection. The test uses the real wrapper with process fakes and checks
the exit reason and that the wrapper did not reach the shared lock or Xcode.

Xcode 27.2 recognized response files in both filter spellings. The tests caught the colon
spelling reaching the fake lock and a passing receipt being created for an external file.
Both spellings now require opt-in without an inline selection and always run fresh.
