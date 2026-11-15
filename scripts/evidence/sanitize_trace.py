"""Portable trace export; discover credentials before replacing all text variants.
Private originals are never changed. Embedded binary media is replaced and logged.
"""
import argparse,base64,hashlib,json,re,zipfile
from pathlib import Path
from urllib.parse import urlsplit,parse_qsl,unquote,quote,quote_plus
PLACEHOLDER=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
def sensitive_name(name):
 name=re.sub(r'[^a-z0-9]','',str(name).lower())
 if name.endswith(('hash','sha256','usage','tokens')):return False
 return name in {'authorization','cookie','setcookie','secret','token','password','apikey','privatekey','seamsession'} or name.endswith(('token','secret','password','apikey','recoverykey','privatekey','masterkey','signingkey','encryptionkey')) or name.startswith('x')and name.endswith(('token','secret'))
def add(value,secrets):
 if isinstance(value,str)and len(value)>=8 and not value.startswith('[REDACTED:'):
  secrets.add(value)
  if value.startswith('Bearer '):secrets.add(value[7:])
  if value.startswith(('Bearer ','Basic '))and value.startswith('Basic '):
   try:
    decoded=base64.b64decode(value[6:]).decode();secrets.add(decoded)
    if ':'in decoded:secrets.add(decoded.split(':',1)[1])
   except(ValueError,UnicodeDecodeError):pass
  if '='in value:
   for m in re.finditer(r'(?:^|;\s*)[^=;]+\s*=\s*([^;]+)',value):
    if len(m[1])>=16:secrets.add(m[1])
def urls(text,secrets):
 for match in re.finditer(r"https?://[^\s\"'<>]+",text):
  try:
   value=urlsplit(match[0])
   for key,item in parse_qsl(value.query,keep_blank_values=True):
    if sensitive_name(key):add(item,secrets)
   if value.password:add(unquote(value.password),secrets)
  except ValueError:pass
 for match in re.finditer(r"(?:^|[?&])([^=&\s]+)=([^&\s\"'<>]+)",text):
  if sensitive_name(unquote(match[1])):add(unquote(match[2]),secrets)
def collect(value,secrets):
 if isinstance(value,dict):
  for key,item in value.items():
   if sensitive_name(key):add(item,secrets)
   collect(item,secrets)
  if sensitive_name(value.get('name',''))or sensitive_name(value.get('key',''))or value.get('type')in ['api-token','webhook-secret','oauth-client']:add(value.get('value'),secrets)
  if value.get('encoding')=='base64':
   for key in ['text','body','data']:
    item=value.get(key)
    if isinstance(item,str)and len(item)<2_000_000:
     try:discover(base64.b64decode(item,validate=True).decode(),secrets)
     except(ValueError,UnicodeDecodeError):pass
 elif isinstance(value,list):
  for item in value:collect(item,secrets)
 elif isinstance(value,str):
  text=value.lstrip()
  if text[:1]in ['{','[']:
   try:collect(json.loads(text),secrets)
   except(ValueError,RecursionError):pass
  urls(value,secrets)
def discover(text,secrets):
 try:collect(json.loads(text),secrets)
 except(ValueError,RecursionError):
  for line in text.splitlines():
   try:collect(json.loads(line),secrets)
   except(ValueError,RecursionError):pass
 urls(text,secrets)
 for m in re.finditer(r'Bearer\s+([A-Za-z0-9._~+/%=-]{8,})',text,re.I):add(m[1],secrets)
 # Covers environment assignments and public trace source literals such as viewerPassword.
 for m in re.finditer(r'([A-Za-z_][\w-]*)\s*[:=]\s*[\"\']?([A-Za-z0-9._~+/%!=-]{8,})',text):
  if sensitive_name(m[1]):add(m[2],secrets)
def variants(value):
 values={value,unquote(value)}
 for item in list(values):
  values.update({quote(item,safe=''),quote_plus(item,safe=''),json.dumps(item,ensure_ascii=True)[1:-1],json.dumps(item,ensure_ascii=False)[1:-1],base64.b64encode(item.encode()).decode(),base64.urlsafe_b64encode(item.encode()).decode()})
 return {v for v in values if len(v)>=8}
def sanitize(source,destination,extra_secrets=()):
 source,destination=Path(source),Path(destination);assert source.resolve()!=destination.resolve()
 with zipfile.ZipFile(source)as z:entries={name:z.read(name)for name in z.namelist()}
 secrets=set(extra_secrets);texts={}
 for name,data in entries.items():
  if data.startswith((b'\x89PNG',b'\xff\xd8',b'RIFF')):continue
  try:text=data.decode('utf-8')
  except UnicodeDecodeError:continue
  texts[name]=text;discover(text,secrets)
 replacements={variant:'[REDACTED:'+hashlib.sha256(secret.encode()).hexdigest()[:12]+']'for secret in secrets for variant in variants(secret)}
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
   text=z.read(name).decode();assert not any(secret in text for secret in replacements),'credential variant remained in public trace'
   try:json.loads(texts[name])
   except ValueError:pass
   else:json.loads(text)
 return {'ok':True,'sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'publicSHA256':hashlib.sha256(destination.read_bytes()).hexdigest(),'secretValuesRedacted':len(secrets),'credentialVariantsChecked':len(replacements),'entries':records,'binaryScreenshotsOmitted':sum(row['binaryOmitted']for row in records),'resourceIdentifiersRetained':True,'scope':'sanitized actions/network/DOM; binary media replaced; source unchanged; separate product screenshots require capture mask/SHA receipt'}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('destination');p.add_argument('--metadata',required=True);a=p.parse_args();result=sanitize(a.source,a.destination);Path(a.metadata).write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in result.items()if k!='entries'}))
