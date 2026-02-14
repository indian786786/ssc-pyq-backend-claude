const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT = 5000; // 5 seconds max

// ================= VALIDATION =================

function validateTopic(topic) {
  if (!topic || typeof topic !== 'string') {
    return { valid: false, error: 'Topic is required and must be a string' };
  }

  const trimmed = topic.trim();

  if (trimmed.length < 3) {
    return { valid: false, error: 'Topic must be at least 3 characters long' };
  }

  if (trimmed.length > 100) {
    return { valid: false, error: 'Topic must be less than 100 characters' };
  }

  const validPattern = /^[a-zA-Z0-9\s\-,.'&()]+$/;
  if (!validPattern.test(trimmed)) {
    return { valid: false, error: 'Topic contains invalid characters' };
  }

  return { valid: true, topic: trimmed };
}

// ================= JSON EXTRACTION =================

function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {}

  const jsonMatch = text.match(/(\[[\s\S]*\])/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1]);
  }

  throw new Error('No valid JSON found in response');
}

// ================= QUESTION VALIDATION =================

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

  const prompt = `
Generate EXACTLY 5 SSC exam multiple choice questions.

Rules:
- SSC CGL/CHSL/GD level
- Factual only
- 4 options
- One correct answer (0-3 index)
- Explanation must be ONE short sentence

Return ONLY JSON array:

[
  {
    "question": "",
    "options": ["", "", "", ""],
    "correct": 0,
    "explanation": ""
  }
]

Topic: ${topic}
`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    console.log(`[AI] Generating 5 questions for: ${topic}`);

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.RAILWAY_PUBLIC_DOMAIN || 'https://railway.app',
        'X-Title': 'SSC Quiz Bot'
      },
      body: JSON.stringify({
        model: 'google/gemma-3n-e4b-it:free',
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 800
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty AI response');
    }

    const questions = extractJSON(content);
    validateQuestions(questions);

    console.log(`[AI] Success`);
    return questions;

  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      throw new Error('Request timeout (5s exceeded)');
    }

    throw error;
  }
}

// ================= ROUTES =================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'SSC PYQ Quiz Generator',
    questions_per_request: 5
  });
});

app.post('/generate', async (req, res) => {
  try {
    const { topic } = req.body;

    const validation = validateTopic(topic);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }

    const questions = await generateQuestions(validation.topic);

    res.json({
      success: true,
      topic: validation.topic,
      total: questions.length,
      questions
    });

  } catch (error) {
    console.error('[ERROR]', error.message);

    res.status(500).json({
      success: false,
      error: error.message
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

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
