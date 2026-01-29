#!/bin/bash
echo "🔄 Actualizando dependencias..."
npm install --omit=dev --no-audit --no-fund

echo "✅ Dependencias actualizadas"
echo "📦 Versiones instaladas:"
npm list --depth=0 | grep -E "(puppeteer|whatsapp|supabase|express)"
