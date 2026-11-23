# November 22 iOS full-suite opt-in

Source fingerprint: `sha256:9a5b0740736b5a8dd76fdb67938f4a4a250957b0de01ccd3c9f38602c97dcbc8`.

The new rejection test failed on the original wrapper. The fake Xcode ran even when the
command omitted a selection. The test uses the real wrapper with process fakes and checks
the exit reason and that the wrapper did not reach the shared lock or Xcode.
