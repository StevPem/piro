# Regenerates test/fixtures/sstv-pysstv-*.i16 and sstv-pysstv.json: SSTV
# audio made by PySSTV (https://github.com/dnet/pySSTV, MIT licence), an
# encoder written independently of slowrx and of PiRO, for
# test/sstv.test.js. See third_party/sstv/README.md.
#
#   pip install pysstv pillow numpy
#   python3 third_party/sstv/make-fixtures.py
#
# Only the start of each transmission is kept (VIS header plus some lines)
# to keep the fixtures small.
import json, os, wave, tempfile
import numpy as np
from PIL import Image
from pysstv import color

FIX = os.path.join(os.path.dirname(__file__), '..', '..', 'test', 'fixtures')
RATE = 12000

def test_image(w, h):
    img = np.zeros((h, w, 3), np.uint8)
    bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]]
    for y in range(h):
        for x in range(w):
            if y < h // 4:
                img[y, x] = bars[x * 8 // w]
            else:
                v = x * 255 // (w - 1)
                img[y, x] = [v, y * 255 // h, 255 - v]
    return img

cases = [('Robot36', 'R36', 10.5), ('MartinM1', 'M1', 12.0), ('PD120', 'PD120', 12.0)]
out = {'generator': 'PySSTV 0.5.9, %d Hz, 16-bit' % RATE, 'cases': []}
for cls_name, mode, seconds in cases:
    cls = getattr(color, cls_name)
    img = test_image(cls.WIDTH, cls.HEIGHT)
    s = cls(Image.fromarray(img), RATE, 16)
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'x.wav')
        s.write_wav(path)
        with wave.open(path) as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), np.int16)
    pcm = pcm[: int(seconds * RATE)]
    name = 'sstv-pysstv-%s.i16' % mode.lower()
    pcm.tofile(os.path.join(FIX, name))
    # the picture itself is not stored: test/sstv.test.js redraws it with the same integer formula
    out['cases'].append({'pysstv': cls_name, 'mode': mode, 'file': name, 'seconds': seconds, 'width': cls.WIDTH, 'height': cls.HEIGHT})
    print(cls_name, len(pcm), 'samples')
with open(os.path.join(FIX, 'sstv-pysstv.json'), 'w') as f:
    json.dump(out, f)
