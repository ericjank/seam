// The OS command line retains the ownership nonce for safe restart/cleanup.
process.argv=process.argv.filter(value=>!value.startsWith('--seam-owned='));
await import('../../apps/connector/dist/cli.js');
