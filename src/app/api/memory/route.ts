import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

const REGISTRY_PATH = path.join(process.cwd(), '.memory-registry.json');
const LOCAL_PATH = path.join(process.cwd(), '.local-memory.json');

export async function GET() {
  let registry = {};
  let localMemory = {};
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {}
  try {
    localMemory = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf-8'));
  } catch {}

  return NextResponse.json({ registry, localMemory });
}
