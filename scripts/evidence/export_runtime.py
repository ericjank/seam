"""Copy public run evidence without Git history, private bootstrap or credentials."""
from pathlib import Path
import argparse,json,hashlib
from sanitize_trace import collect,variants
p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('destination');a=p.parse_args();source=Path(a.source);destination=Path(a.destination);secrets=set();excluded=[];records=[]
for path in (source/'private').rglob('*'):
 if path.is_file():
  data=path.read_bytes();excluded.append({'path':str(path.relative_to(source)),'sha256':hashlib.sha256(data).hexdigest(),'reason':'private connector bootstrap and process ownership data'})
  try:collect(json.loads(data),secrets)
  except(ValueError,UnicodeDecodeError):pass
# Also discover journal recovery credentials before copying any public file.
for path in source.rglob('*.json'):
 try:collect(json.loads(path.read_text()),secrets)
 except(ValueError,UnicodeDecodeError):pass
secrets={variant for secret in secrets for variant in variants(secret)}
for path in source.rglob('*'):
 relative=path.relative_to(source)
 if any(part in ['.git','private','__pycache__']for part in relative.parts)or path.name.endswith('.lock')or'.queue.'in path.name:continue
 if not path.is_file():continue
 assert not path.is_symlink(),relative
 if path.name.startswith('.env')and path.name!='.env.example':excluded.append({'path':str(relative),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'reason':'private environment'});continue
 data=path.read_bytes();public=data
 for secret in secrets:public=public.replace(secret.encode(),('[REDACTED:'+hashlib.sha256(secret.encode()).hexdigest()[:12]+']').encode())
 assert not any(secret.encode()in public for secret in secrets)
 target=destination/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(public);records.append({'path':str(relative),'sha256':hashlib.sha256(public).hexdigest(),'redacted':public!=data})
(destination.parent/'runtime-export.json').write_text(json.dumps({'ok':True,'files':len(records),'privateFilesExcluded':excluded,'credentialValuesChecked':len(secrets),'publicFilesRedacted':sum(row['redacted']for row in records),'allActualTokenValuesAbsent':True,'filesManifest':records},ensure_ascii=False,indent=2));print(json.dumps({'ok':True,'files':len(records),'excludedPrivateFiles':len(excluded),'credentialValuesChecked':len(secrets),'publicFilesRedacted':sum(row['redacted']for row in records)}))
