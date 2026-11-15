import tempfile,unittest,json,zipfile,hashlib,base64
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
 def test_key_header_query_and_source_aliases_are_removed(self):
  cases=[{'access_token':'SyntheticAccess_123456789'}, {'client_secret':'SyntheticClient_123456789'}, {'headers':[{'name':'X-API-Key','value':'SyntheticHeader_123456789'}]}, {'url':'https://example.test/?access_token=SyntheticQuery_123456789'}, {'refreshToken':'SyntheticRefresh_123456789'}, {'recoveryKey':'SyntheticRecovery_123456789'}]
  with tempfile.TemporaryDirectory()as root:
   raw=Path(root)/'raw.zip';public=Path(root)/'public.zip'
   with zipfile.ZipFile(raw,'w')as z:
    for index,value in enumerate(cases):z.writestr(f'{index}.network',json.dumps(value))
   sanitize(raw,public)
   with zipfile.ZipFile(public)as z:
    for name in z.namelist():self.assertNotIn(b'Synthetic',z.read(name))
 def test_encoded_copies_are_scrubbed_and_semantic_metadata_kept(self):
  token='Private+/secret=123456789';encoded=base64.b64encode(token.encode()).decode()
  with tempfile.TemporaryDirectory()as root:
   raw=Path(root)/'raw.zip';public=Path(root)/'public.zip'
   with zipfile.ZipFile(raw,'w')as z:
    z.writestr('body.json',json.dumps({'token':token,'copy':encoded,'url':'https://example.test/?access_token=Private%2B%2Fsecret%3D123456789','tokenUsage':{'inputTokens':123},'specHash':'a'*64}))
   sanitize(raw,public)
   with zipfile.ZipFile(public)as z:
    value=json.loads(z.read('body.json'));self.assertEqual(value['tokenUsage']['inputTokens'],123);self.assertEqual(value['specHash'],'a'*64);self.assertNotIn(token,json.dumps(value));self.assertNotIn(encoded,json.dumps(value));self.assertNotIn('Private%2B',value['url'])
if __name__=='__main__':unittest.main()
