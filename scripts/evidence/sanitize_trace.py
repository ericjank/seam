"""Shareable Playwright trace: scrub credentials, retain actions/network/DOM.
Embedded binary screenshots are replaced; separately reviewed product PNGs remain.
Raw files are never modified. Public metadata accounts for every ZIP entry.
"""
import argparse,base64,hashlib,json,re,zipfile
from pathlib import Path
SECRET=re.compile(r'^(?:token|password|secret|api[_-]?key|authorization|cookie|set-cookie|session[_-]?token)$',re.I)
PLACEHOLDER=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
def collect(value,secrets):
 if isinstance(value,dict):
  for key,item in value.items():
   if SECRET.match(key)and isinstance(item,str)and len(item)>=8:secrets.add(item)
   collect(item,secrets)
  if str(value.get('name','')).lower()in ['authorization','cookie','set-cookie']:
   value=value.get('value','')
   if isinstance(value,str):
    if len(value)>=8:secrets.add(value)
    if value.startswith('Bearer '):secrets.add(value[7:])
    for match in re.finditer(r'(?:^|;\s*)[^=;]+\s*=\s*([^;]+)',value):
     if len(match[1])>=16:secrets.add(match[1])
 elif isinstance(value,list):
  for item in value:collect(item,secrets)
 elif isinstance(value,str)and value[:1]in ['{','[']:
  try:collect(json.loads(value),secrets)
  except (ValueError,RecursionError):pass

def discover(text,secrets):
 try:collect(json.loads(text),secrets)
 except(ValueError,RecursionError):
  for line in text.splitlines():
   try:collect(json.loads(line),secrets)
   except(ValueError,RecursionError):pass
 for match in re.finditer(r'(?:Bearer |SEAM_AGENT_TOKEN=)([A-Za-z0-9_-]{20,})',text):secrets.add(match[1])
 for match in re.finditer(r'seam_session=([A-Za-z0-9_-]{20,})',text):secrets.add(match[1])

def sanitize(source,destination,extra_secrets=()):
 source,destination=Path(source),Path(destination);assert source.resolve()!=destination.resolve()
 with zipfile.ZipFile(source)as z:entries={name:z.read(name)for name in z.namelist()}
 secrets=set(extra_secrets);texts={}
 for name,data in entries.items():
  if data.startswith((b'\x89PNG',b'\xff\xd8',b'RIFF')):continue
  try:text=data.decode('utf-8')
  except UnicodeDecodeError:continue
  texts[name]=text;discover(text,secrets)
 replacements={secret:'[REDACTED:'+hashlib.sha256(secret.encode()).hexdigest()[:12]+']'for secret in secrets if len(secret)>=8}
 destination.parent.mkdir(parents=True,exist_ok=True);records=[]
 with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED)as z:
  for name,data in entries.items():
   if name in texts:
    text=texts[name]
    for secret in sorted(replacements,key=len,reverse=True):text=text.replace(secret,replacements[secret])
    output=text.encode();binary=False
   else:output=PLACEHOLDER if data.startswith((b'\x89PNG',b'\xff\xd8',b'RIFF'))else b'';binary=True
   z.writestr(name,output);records.append({'entry':name,'originalSHA256':hashlib.sha256(data).hexdigest(),'publicSHA256':hashlib.sha256(output).hexdigest(),'binaryOmitted':binary})
 with zipfile.ZipFile(destination)as z:
  assert z.testzip()is None
  for name in texts:
   text=z.read(name).decode()
   assert not any(secret in text for secret in replacements),'credential remained in portable trace'
 return {'ok':True,'sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'publicSHA256':hashlib.sha256(destination.read_bytes()).hexdigest(),'secretValuesRedacted':len(replacements),'entries':records,'binaryScreenshotsOmitted':sum(row['binaryOmitted']for row in records),'resourceIdentifiersRetained':True,'scope':'portable sanitized actions/network/DOM; binary screenshots replaced, reviewed UI screenshots delivered separately; raw retained privately'}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('destination');p.add_argument('--metadata',required=True);a=p.parse_args();result=sanitize(a.source,a.destination);Path(a.metadata).write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in result.items()if k!='entries'}))
