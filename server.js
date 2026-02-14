const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// 🚀 FAST FREE MODELS - Ordered by speed and reliability
const MODEL_FALLBACK_LIST = [
  'google/gemini-flash-1.5',           // Best: Fast, reliable, great JSON
  'google/gemini-flash-1.5-8b',        // Faster variant
  'meta-llama/llama-3.2-3b-instruct:free', // Very fast, good quality
  'microsoft/phi-3-mini-128k-instruct:free', // Fast, decent for MCQs
  'google/gemma-2-9b-it:free'          // Backup option
];

// ⏱️ CRITICAL: 5-second timeout for speed
const REQUEST_TIMEOUT = 5000;

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

function extractJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // Continue
  }
  
  const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch (e) {
      // Continue
    }
  }
  
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e) {
      // Continue
    }
  }
  
  throw new Error('No valid JSON found in response');
}

function validateQuestions(questions) {
  if (!Array.isArray(questions)) {
    throw new Error('Questions must be an array');
  }
  
  // ✅ NOW EXPECTING 5 QUESTIONS
  if (questions.length !== 5) {
    throw new Error(`Expected 5 questions, got ${questions.length}`);
  }
  
  questions.forEach((q, index) => {
    if (!q.question || typeof q.question !== 'string') {
      throw new Error(`Question ${index + 1}: Missing or invalid 'question' field`);
    }
    
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      throw new Error(`Question ${index + 1}: Must have exactly 4 options`);
    }
    
    if (typeof q.correct !== 'number' || q.correct < 0 || q.correct > 3) {
      throw new Error(`Question ${index + 1}: 'correct' must be 0, 1, 2, or 3`);
    }
    
    if (!q.explanation || typeof q.explanation !== 'string') {
      throw new Error(`Question ${index + 1}: Missing or invalid 'explanation' field`);
    }
  });
  
  return true;
}

// 🎯 OPTIMIZED PROMPT - Shorter, faster, clearer
function getSystemPrompt() {
  return `Generate EXACTLY 5 SSC exam MCQs. Return ONLY JSON array, no markdown, no text.

Format:
[
  {
    "question": "Question text?",
    "options": ["A", "B", "C", "D"],
    "correct": 0,
    "explanation": "Brief 1-2 sentence explanation."
  }
]

Rules:
- SSC standard difficulty
- 4 options each
- 1 correct answer (index 0-3)
- Short explanations only
- Valid JSON only`;
}

// 🚀 SMART MODEL FALLBACK - Tries models until one succeeds
async function generateQuestionsWithFallback(topic) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not configured');
  }

  const systemPrompt = getSystemPrompt();
  const userPrompt = `Generate 5 SSC-level MCQs on: ${topic}`;

  let lastError = null;
  
  // 🔄 Try each model in order
  for (let i = 0; i < MODEL_FALLBACK_LIST.length; i++) {
    const model = MODEL_FALLBACK_LIST[i];
    const isLastModel = i === MODEL_FALLBACK_LIST.length - 1;
    
    try {
      console.log(`[ATTEMPT ${i + 1}/${MODEL_FALLBACK_LIST.length}] Trying model: ${model}`);
      
      const questions = await callOpenRouterAPI(model, systemPrompt, userPrompt, topic);
      
      console.log(`[SUCCESS] Model ${model} generated ${questions.length} questions`);
      return questions;
      
    } catch (error) {
      lastError = error;
      const errorMsg = error.message || 'Unknown error';
      
      console.log(`[FAILED] Model ${model}: ${errorMsg}`);
      
      // Check if we should try next model
      const shouldRetry = 
        errorMsg.includes('429') ||      // Rate limit
        errorMsg.includes('404') ||      // Model not found
        errorMsg.includes('400') ||      // Bad request
        errorMsg.includes('timeout') ||  // Timeout
        errorMsg.includes('503') ||      // Service unavailable
        errorMsg.includes('502');        // Bad gateway
      
      if (!shouldRetry || isLastModel) {
        // Don't retry for other errors or if this was the last model
        console.log(`[FINAL ERROR] All models failed or non-retryable error`);
        throw lastError;
      }
      
      // Continue to next model
      console.log(`[RETRY] Trying next model...`);
    }
  }
  
  // If we get here, all models failed
  throw new Error(lastError?.message || 'All models failed to generate questions');
}

// 🔧 SINGLE API CALL FUNCTION
async function callOpenRouterAPI(model, systemPrompt, userPrompt, topic) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.RAILWAY_PUBLIC_DOMAIN || 'https://ssc-pyq-quiz.railway.app',
        'X-Title': 'SSC PYQ Quiz Generator'
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,  // Lower for more consistent output
        max_tokens: 1200,  // Reduced for 5 questions
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // Handle HTTP errors
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Error ${response.status}: ${errorText.substring(0, 100)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from API');
    }

    // Extract and validate JSON
    const questions = extractJSON(content);
    validateQuestions(questions);
    
    return questions;

  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      throw new Error('Request timeout - took longer than 5 seconds');
    }
    
    throw error;
  }
}

// 🌐 HEALTH CHECK ENDPOINT
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'SSC PYQ Quiz Generator',
    version: '2.0',
    features: {
      questions_per_request: 5,
      timeout_seconds: 5,
      model_fallback: true,
      active_models: MODEL_FALLBACK_LIST.length
    },
    timestamp: new Date().toISOString()
  });
});

// 🎯 MAIN GENERATION ENDPOINT
app.post('/generate', async (req, res) => {
  const startTime = Date.now();
  console.log('[REQUEST] Generate request received');
  
  try {
    const { topic } = req.body;
    
    // Validate topic
    const validation = validateTopic(topic);
    if (!validation.valid) {
      console.log(`[VALIDATION] Failed: ${validation.error}`);
      return res.status(400).json({
        success: false,
        error: validation.error
      });
    }

    const validatedTopic = validation.topic;
    console.log(`[VALIDATION] Topic: "${validatedTopic}"`);

    // Generate questions with auto-fallback
    const questions = await generateQuestionsWithFallback(validatedTopic);

    const duration = Date.now() - startTime;
    console.log(`[SUCCESS] Generated ${questions.length} questions in ${duration}ms`);

    res.json({
      success: true,
      topic: validatedTopic,
      total: questions.length,
      questions: questions,
      _meta: {
        duration_ms: duration,
        version: '2.0'
      }
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('[ERROR]', error.message);
    
    // Determine appropriate status code
    let statusCode = 500;
    if (error.message.includes('timeout')) {
      statusCode = 504;
    } else if (error.message.includes('rate limit') || error.message.includes('429')) {
      statusCode = 429;
    }
    
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to generate questions',
      _meta: {
        duration_ms: duration
      }
    });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('[FATAL ERROR]', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`✅ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✅ API Key configured: ${OPENROUTER_API_KEY ? 'Yes' : 'No'}`);
  console.log(`✅ Questions per request: 5`);
  console.log(`✅ Timeout: ${REQUEST_TIMEOUT}ms`);
  console.log(`✅ Model fallback enabled: ${MODEL_FALLBACK_LIST.length} models`);
  console.log(`✅ Primary model: ${MODEL_FALLBACK_LIST[0]}`);
});
