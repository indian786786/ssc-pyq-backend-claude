const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT = 5000; // 5 seconds

// ================= VALIDATE TOPIC =================

function validateTopic(topic) {
  if (!topic || typeof topic !== 'string') {
    return { valid: false, error: 'Topic is required and must be a string' };
  }

  const trimmed = topic.trim();

  if (trimmed.length < 3) {
    return { valid: false, error: 'Topic must be at least 3 characters long' };
  }

  if (trimmed.length > 200) {
    return { valid: false, error: 'Topic must be less than 200 characters' };
  }

  const validPattern = /^[a-zA-Z0-9\s\-,.'&()]+$/;
  if (!validPattern.test(trimmed)) {
    return { valid: false, error: 'Topic contains invalid characters' };
  }

  return { valid: true, topic: trimmed };
}

// ================= JSON EXTRACTION =================

function extractJSON(text) {
  // Try direct parse
  try {
    return JSON.parse(text);
  } catch {}

  // Try to extract array from text
  const match = text.match(/(\[[\s\S]*\])/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {}
  }

  throw new Error('Invalid JSON from AI');
}

// ================= VALIDATE QUESTIONS =================

function validateQuestions(questions) {
  if (!Array.isArray(questions)) {
    throw new Error('Questions must be an array');
  }

  if (questions.length !== 5) {
    throw new Error(`Expected 5 questions, got ${questions.length}`);
  }

  questions.forEach((q, index) => {
    if (!q.question || typeof q.question !== 'string') {
      throw new Error(`Question ${index + 1}: Invalid question`);
    }

    if (!Array.isArray(q.options) || q.options.length !== 4) {
      throw new Error(`Question ${index + 1}: Must have 4 options`);
    }

    if (typeof q.correct !== 'number' || q.correct < 0 || q.correct > 3) {
      throw new Error(`Question ${index + 1}: Invalid correct index`);
    }

    if (!q.explanation || typeof q.explanation !== 'string') {
      throw new Error(`Question ${index + 1}: Invalid explanation`);
    }
  });

  return true;
}

// ================= GENERATE QUESTIONS =================

async function generateQuestions(topic) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not configured');
  }

  // Fast FREE models - try in order
  const MODELS = [
    'google/gemini-flash-1.5',
    'google/gemini-flash-1.5-8b',
    'meta-llama/llama-3.2-3b-instruct:free',
    'microsoft/phi-3-mini-128k-instruct:free'
  ];

  const prompt = `Generate EXACTLY 5 SSC exam multiple choice questions.

Topic: ${topic}

Rules:
- SSC CGL/CHSL/GD difficulty level
- Factual and exam-oriented
- Each question has exactly 4 options
- One correct answer (index 0-3)
- Brief explanation (1-2 sentences)

Return ONLY a JSON array in this exact format:
[
  {
    "question": "Question text here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 0,
    "explanation": "Brief explanation."
  }
]

Generate 5 questions now. Return only the JSON array, no other text.`;

  let lastError = null;

  for (let model of MODELS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      console.log(`[TRY] Model: ${model}`);

      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': process.env.RAILWAY_PUBLIC_DOMAIN || 'https://railway.app',
          'X-Title': 'SSC Quiz Bot'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 1200
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`[FAIL] ${model}: ${response.status}`);
        lastError = new Error(`API error ${response.status}`);
        continue;
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;

      if (!content) {
        console.log(`[FAIL] ${model}: Empty response`);
        lastError = new Error('Empty response');
        continue;
      }

      const questions = extractJSON(content);
      validateQuestions(questions);

      console.log(`[SUCCESS] ${model}: ${questions.length} questions`);
      return questions;

    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        console.log(`[TIMEOUT] ${model}`);
        lastError = new Error('Request timeout (5s)');
      } else {
        console.log(`[ERROR] ${model}: ${error.message}`);
        lastError = error;
      }

      continue;
    }
  }

  // All models failed
  throw lastError || new Error('All AI models failed. Please try again.');
}

// ================= ROUTES =================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'SSC PYQ Quiz Generator',
    questions_per_request: 5,
    timestamp: new Date().toISOString()
  });
});

app.post('/generate', async (req, res) => {
  const startTime = Date.now();

  try {
    console.log('[REQUEST] Generate quiz');

    const { topic } = req.body;

    const validation = validateTopic(topic);
    if (!validation.valid) {
      console.log(`[INVALID] ${validation.error}`);
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }

    console.log(`[TOPIC] ${validation.topic}`);

    const questions = await generateQuestions(validation.topic);

    const duration = Date.now() - startTime;
    console.log(`[SUCCESS] ${questions.length} questions in ${duration}ms`);

    res.json({
      success: true,
      topic: validation.topic,
      total: questions.length,
      questions: questions
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[ERROR] ${error.message} (${duration}ms)`);

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate questions'
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[FATAL]', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// ================= START SERVER =================

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ API Key: ${OPENROUTER_API_KEY ? 'Configured' : 'MISSING'}`);
  console.log(`✅ Timeout: ${REQUEST_TIMEOUT}ms`);
});
