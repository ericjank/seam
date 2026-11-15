import tempfile,unittest,json,zipfile,hashlib
from pathlib import Path
from sanitize_trace import sanitize,PLACEHOLDER
class TraceRedaction(unittest.TestCase):
 def test_portable_actions_and_dom_preserved_without_credentials(self):
  with tempfile.TemporaryDirectory()as root:
   root=Path(root);raw=root/'raw.zip';public=root/'public.zip';token='SeamTestPrivateToken_1234567890123456';cookie='PrivateSession_1234567890123456'
   with zipfile.ZipFile(raw,'w')as z:
    z.writestr('0-trace.trace',json.dumps({'type':'before','callId':'click-1','text':'token='+token}))
    z.writestr('0-trace.network',json.dumps({'headers':[{'name':'Authorization','value':'Bearer '+token},{'name':'Cookie','value':'seam_session='+cookie}]}))
    z.writestr('resources/body.json',json.dumps({'agent':{'token':token},'password':'test-password-private'}))
    z.writestr('resources/screen.png',PLACEHOLDER)
   original=raw.read_bytes();report=sanitize(raw,public)
   self.assertEqual(raw.read_bytes(),original);self.assertTrue(report['ok']);self.assertEqual(report['binaryScreenshotsOmitted'],1)
   with zipfile.ZipFile(public)as z:
    self.assertEqual(len(z.namelist()),4)
    for name in z.namelist():self.assertNotIn(token.encode(),z.read(name));self.assertNotIn(cookie.encode(),z.read(name))
    self.assertEqual(json.loads(z.read('0-trace.trace'))['callId'],'click-1')
 def test_session_in_dom_is_found_even_without_auth_network_event(self):
  with tempfile.TemporaryDirectory()as root:
   raw=Path(root)/'raw.zip';public=Path(root)/'public.zip'
   with zipfile.ZipFile(raw,'w')as z:z.writestr('trace.trace','seam_session=isolated_secret_12345678901234567890')
   report=sanitize(raw,public);self.assertTrue(report['ok'])
   with zipfile.ZipFile(public)as z:self.assertNotIn(b'isolated_secret_12345678901234567890',z.read('trace.trace'))
if __name__=='__main__':unittest.main()
