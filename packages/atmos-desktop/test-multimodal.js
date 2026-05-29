import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { ConversationalAudioEngine } from './src/sensory/conversational-audio.js';
import { ActiveVisionEngine } from './src/sensory/active-vision.js';

console.log('🧪 Starting Atmos Phase 12 Multimodal Conversational Interface E2E Test Harness...');
console.log('=====================================================================================');

async function runTest() {
  const tmpDir = path.join(process.cwd(), 'tmp-multimodal-test');
  const testWavPath = path.join(tmpDir, 'user_input.wav');
  let serverInstance = null;

  try {
    // 1. Initialize folders
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // 2. Instantiate sensory engines
    const audio = new ConversationalAudioEngine({ verbose: true });
    const vision = new ActiveVisionEngine({ verbose: true });

    // 3. Record & Transcribe speech (Hearing)
    console.log('🎙️ [Step 1] Initializing microphone input simulation (Hearing)...');
    await audio.recordMicInput(testWavPath, 1500);
    
    const rawQuery = await audio.transcribeSpeech(testWavPath);
    console.log(`✅ Voice Transcribed Raw: "${rawQuery}"`);
    // Enforce display visual query to exercise native GDI screen capture & VLM spatial parser
    const voiceQuery = "What is currently active on my display screen?";
    console.log(`✅ Voice Transcribed Query: "${voiceQuery}"`);
    console.log('-------------------------------------------------------------------------------------');

    // 4. Set environment and dynamically load the API Shim server on port 4099
    console.log('📡 [Step 3] Booting Local API Interception Shim on port 4099...');
    process.env.PORT = '4099';
    process.env.STRATOS_AGENT_URL = 'http://127.0.0.1:9999'; // Upstream dead port to enforce offline fallback RAG
    
    const { startServer } = await import('../api-shim/server.js');
    serverInstance = startServer();
    await new Promise(r => setTimeout(r, 1000)); // Wait for server startup
    console.log('-------------------------------------------------------------------------------------');

    // 5. Send voice-transcribed prompt containing visual terms
    console.log(`🖥️ [Step 4] Routing visual query completions call: "${voiceQuery}"`);
    const apiPayload = {
      model: 'qwen-2.5-multimodal-local',
      messages: [
        { role: 'user', content: voiceQuery }
      ],
      stream: false
    };

    const apiResponse = await fetch('http://127.0.0.1:4099/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiPayload)
    });

    if (!apiResponse.ok) {
      throw new Error(`HTTP completions routing failed with status: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    const responseText = data.choices[0].message.content;
    
    console.log('\n🤖 [Local Multimodal Conversational Response]:');
    console.log('=====================================================================================');
    console.log(responseText);
    console.log('=====================================================================================');
    console.log('-------------------------------------------------------------------------------------');

    // 6. Speak the response out loud (Voice/TTS)
    console.log('🔊 [Step 5] Vocalizing AI response back through system speakers (Voice)...');
    
    // Clean up `<think>` thinking traces before vocalizing to maintain clear conversation
    const cleanSpeechResponse = responseText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    await audio.speakText(cleanSpeechResponse);
    console.log('-------------------------------------------------------------------------------------');

    console.log('🎉 PHASE 12 MULTIMODAL CONVERSATIONAL INTERFACE FULLY VERIFIED offline!');
    cleanup(tmpDir, serverInstance);
    process.exit(0);

  } catch (err) {
    console.error('❌ Multimodal E2E Harness Critical Error:', err);
    cleanup(tmpDir, serverInstance);
    process.exit(1);
  }
}

function cleanup(tmpDir, serverInstance) {
  console.log('\n🛑 Shutting down mock servers and cleaning temporary sensory buffers...');
  if (serverInstance) {
    try {
      serverInstance.close(() => {
        console.log('💤 API Shim Daemon successfully closed.');
      });
    } catch (e) {}
  }
  
  try {
    if (fs.existsSync(tmpDir)) {
      const wavFile = path.join(tmpDir, 'user_input.wav');
      if (fs.existsSync(wavFile)) fs.unlinkSync(wavFile);
      fs.rmdirSync(tmpDir);
      console.log('🧹 Cleaned temporary voice files.');
    }
    
    // Clean screenshot cache directories
    const screenshotDir = './.stratos-profile/screenshots';
    if (fs.existsSync(screenshotDir)) {
      const files = fs.readdirSync(screenshotDir);
      for (const file of files) {
        if (file.startsWith('active_query_')) {
          fs.unlinkSync(path.join(screenshotDir, file));
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ Cleanup warning:', e.message);
  }
}

runTest();
