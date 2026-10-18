# Audio fixture

`tone.mp3` is a one-second, quiet 220 Hz tone generated for decoder lifecycle tests:
24 kHz mono signed 16-bit PCM, encoded with LAME (lameenc 1.9.0), 48 kbit/s.
It contains no speech or third-party recording. The encoder is not an app or test
runtime dependency.

The browser test mutes playback and checks actual MP3 streaming, decoder release,
and replay from the compressed cache. This fixture is not included in the app.
