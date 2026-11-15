import tempfile,unittest,json,hashlib,subprocess,sys
from pathlib import Path
from sanitize_trace import PLACEHOLDER
class ScreenshotExport(unittest.TestCase):
 def test_only_capture_mask_receipts_with_matching_hash_are_public(self):
  with tempfile.TemporaryDirectory()as root:
   root=Path(root);raw=root/'raw';public=root/'public';raw.mkdir();(raw/'unreviewed.png').write_bytes(PLACEHOLDER);image=raw/'masked.png';image.write_bytes(PLACEHOLDER);Path(str(image)+'.public.json').write_text(json.dumps({'captureMaskApplied':True,'sha256':hashlib.sha256(PLACEHOLDER).hexdigest()}))
   subprocess.run([sys.executable,str(Path(__file__).with_name('export_browser_evidence.py')),str(raw),str(public)],check=True,stdout=subprocess.DEVNULL)
   self.assertTrue((public/'masked.png').exists());self.assertFalse((public/'unreviewed.png').exists());ledger=json.loads((public/'browser-evidence.json').read_text());self.assertEqual(len(ledger['unreviewedScreenshotsKeptPrivate']),1)
 def test_wrong_capture_receipt_fails_export(self):
  with tempfile.TemporaryDirectory()as root:
   root=Path(root);raw=root/'raw';raw.mkdir();image=raw/'masked.png';image.write_bytes(PLACEHOLDER);Path(str(image)+'.public.json').write_text(json.dumps({'captureMaskApplied':True,'sha256':'0'*64}))
   result=subprocess.run([sys.executable,str(Path(__file__).with_name('export_browser_evidence.py')),str(raw),str(root/'public')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);self.assertNotEqual(result.returncode,0)
if __name__=='__main__':unittest.main()
