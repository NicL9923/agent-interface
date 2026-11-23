# November 22 iOS full-suite opt-in

Source fingerprint: .

The new rejection test failed on the original wrapper. The fake Xcode ran even when the
command omitted a selection. The test uses the real wrapper with process fakes and checks
the exit reason and that the wrapper did not reach the shared lock or Xcode.
