# Radiofax fixtures

`fax-vmc-satellite.grey.gz` and `fax-vmc-text.grey.gz` are two charts
received off air from VMC (Bureau of Meteorology, Charleville) with PiRO
v97, slanted, as the operator reported them. Every 4th line of the
1810-pixel-wide chart is kept, as raw 8-bit grey (0 black, 255 white),
gzipped. `test/fax.test.js` repeats each line 4 times and checks that
`deslant()` straightens them.

The charts are © Commonwealth of Australia, Bureau of Meteorology. They are
kept here only to test the receiver.
