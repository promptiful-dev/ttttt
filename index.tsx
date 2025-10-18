import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';


// --- New System Instruction for Quantum AI Engine ---
const QUANTUM_SYSTEM_INSTRUCTION = `
You are the "Quantum AI Engine" for the Test Me app. Your mission is to generate a high-quality quiz based on user-provided images and specific settings.

**INPUT:** You will receive OCR text from one or more images, along with a requested question count and difficulty level.

**CRITICAL DIRECTIVES:**
- **Fulfill the Exact Request:** You MUST generate the exact number of questions requested for the specified difficulty level. If the source material is insufficient to meet this request, you must return an 'errors' object with a clear message explaining why.
- **Factual Accuracy:** All questions, options, and explanations MUST be derived exclusively from the provided OCR text. Do not introduce external information.
- **Difficulty-Tuned Questions:**
    - **Easy:** Simple, direct recall questions.
    - **Medium:** Questions requiring some inference or connection of ideas.
    - **Hard:** Complex questions requiring synthesis or analysis of information from the text.
- **Quality Control:** Ensure distractors (incorrect options) are plausible but clearly wrong according to the source text. The explanation should clarify the correct answer, referencing the text.
- **Sponsored Insight:** Create a single, concise 'sponsored_insight' text. This should be a helpful, relevant "next step" or a fascinating fact related to the quiz's main topic.
- **Summary:** Provide a brief, one or two-sentence summary of the source material.

Your final output MUST be a single, valid JSON object matching the provided schema, containing a single array of questions.
`;

// --- Data Shapes ---
interface ImageFile {
  id: string;
  name: string;
  type: string;
  base64: string;
}

interface QuizQuestion {
  id: string;
  difficulty: string;
  question_text: string;
  options: string[];
  correct_index: number;
  explanation: string;
}

interface QuizResponse {
    summary: string;
    sponsored_insight: string;
    quiz: QuizQuestion[];
    errors?: { error_message: string }[];
}

interface QuizSettings {
    questionCount: number;
    difficulty: 'easy' | 'medium' | 'hard';
}

type AnswerStatus = 'correct' | 'incorrect' | 'unanswered';

// --- Main App Component ---
const App: React.FC = () => {
  const [screen, setScreen] = useState<'home' | 'transition' | 'quiz' | 'result'>('home');
  const [images, setImages] = useState<ImageFile[]>([]);
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [answerHistory, setAnswerHistory] = useState<AnswerStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastQuizSummary, setLastQuizSummary] = useState<string | null>(null);
  const [sponsoredInsight, setSponsoredInsight] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [quizSettings, setQuizSettings] = useState<QuizSettings>(() => {
    try {
        const savedSettings = localStorage.getItem('quiz_settings');
        if (savedSettings) {
            const parsedSettings = JSON.parse(savedSettings);
            if (parsedSettings.questionCount && parsedSettings.difficulty) {
                return parsedSettings;
            }
        }
    } catch (error) {
        console.error("Failed to load or parse quiz settings from localStorage", error);
    }
    return { questionCount: 10, difficulty: 'medium' };
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const storedKey = localStorage.getItem('gemini_api_key');
    if (storedKey) {
      setApiKey(storedKey);
    }
  }, []);

  useEffect(() => {
    try {
        localStorage.setItem('quiz_settings', JSON.stringify(quizSettings));
    } catch (error) {
        console.error("Failed to save quiz settings to localStorage", error);
    }
  }, [quizSettings]);

  const initAudio = () => {
    if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
  };

  const playSound = (type: 'correct' | 'wrong' | 'next') => {
    if (!audioContextRef.current || isMuted) return;
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') { ctx.resume(); }

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    switch (type) {
        case 'correct':
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(880, ctx.currentTime);
            gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
            oscillator.start(ctx.currentTime);
            oscillator.stop(ctx.currentTime + 0.25);
            break;
        case 'wrong':
            oscillator.type = 'square';
            oscillator.frequency.setValueAtTime(120, ctx.currentTime);
            gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
            oscillator.start(ctx.currentTime);
            oscillator.stop(ctx.currentTime + 0.2);
            break;
        case 'next':
            const bufferSize = ctx.sampleRate * 0.15;
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const output = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) { output[i] = Math.random() * 2 - 1; }
            const whiteNoise = ctx.createBufferSource();
            whiteNoise.buffer = buffer;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.2, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
            whiteNoise.connect(gain);
            gain.connect(ctx.destination);
            whiteNoise.start(ctx.currentTime);
            whiteNoise.stop(ctx.currentTime + 0.15);
            break;
    }
  };
  
  const createParticles = () => {
    const container = document.getElementById('particle-container');
    if (!container) return;
    const colors = ['var(--success-color)', 'var(--primary-accent)', '#FFD700', 'var(--secondary-accent)'];
    const particleCount = 30;

    for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';

        const angle = Math.random() * 360;
        const radius = Math.random() * 150 + 50;
        const endX = Math.cos(angle * Math.PI / 180) * radius;
        const endY = Math.sin(angle * Math.PI / 180) * radius - 200;
        
        const duration = Math.random() * 0.8 + 0.5; // 0.5s to 1.3s
        const delay = Math.random() * 0.2;
        const size = Math.random() * 4 + 2; // 2px to 6px

        particle.style.setProperty('--end-x', `${endX}px`);
        particle.style.setProperty('--end-y', `${endY}px`);
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        particle.style.backgroundColor = colors[i % colors.length];
        particle.style.animation = `celebrate-burst ${duration}s cubic-bezier(0.1, 0.8, 0.7, 1.0) ${delay}s forwards`;
        
        container.appendChild(particle);
        setTimeout(() => particle.remove(), (duration + delay) * 1000);
    }
  };

  const resetApp = () => {
    setImages([]);
    setQuestions([]);
    setCurrentQuestionIndex(0);
    setScore(0);
    setSelectedAnswer(null);
    setIsAnswered(false);
    setAnswerHistory([]);
    setError(null);
    setLastQuizSummary(null);
    setSponsoredInsight(null);
    setIsLoading(false);
    setScreen('home');
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    const newImages: ImageFile[] = [];
    Array.from(files).forEach((file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = (e.target?.result as string).split(',')[1];
        newImages.push({ id: `${file.name}-${Date.now()}`, name: file.name, type: file.type, base64 });
        if (newImages.length === files.length) {
          setImages(prev => [...prev, ...newImages]);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (id: string) => {
    setImages(prev => prev.filter(img => img.id !== id));
  };

  const generateAndStartQuiz = async (settings: QuizSettings) => {
    setIsLoading(true);
    setError(null);

    if (!apiKey) {
        setError("API Key is not set. Please add your key in the settings.");
        setIsLoading(false);
        setScreen('home');
        return;
    }

    try {
        const ai = new GoogleGenAI({ apiKey });
        const imageParts = images.map(image => ({
            inlineData: { mimeType: image.type, data: image.base64 },
        }));

        const userInputPayload = {
            app_name: "Test Me",
            quiz_request: {
                difficulty: settings.difficulty,
                question_count: settings.questionCount,
            },
            image_ids: images.map(img => img.id)
        };
        const textPart = { text: `USER INPUT PAYLOAD: ${JSON.stringify(userInputPayload)}` };

        const questionItemSchema = {
            type: Type.OBJECT,
            properties: {
                id: { type: Type.STRING },
                difficulty: { type: Type.STRING },
                question_text: { type: Type.STRING },
                options: { type: Type.ARRAY, items: { type: Type.STRING } },
                correct_index: { type: Type.INTEGER },
                explanation: { type: Type.STRING },
            },
            required: ["id", "difficulty", "question_text", "options", "correct_index", "explanation"]
        };
        
        const responseSchema = {
            type: Type.OBJECT,
            properties: {
                summary: { type: Type.STRING },
                sponsored_insight: { type: Type.STRING },
                quiz: {
                    type: Type.ARRAY,
                    items: questionItemSchema
                },
                errors: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            error_message: { type: Type.STRING }
                        }
                    }
                }
            },
            required: ["summary", "sponsored_insight", "quiz"]
        };

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [textPart, ...imageParts] },
            config: { systemInstruction: QUANTUM_SYSTEM_INSTRUCTION, responseMimeType: "application/json", responseSchema }
        });
        
        const responseJson: QuizResponse = JSON.parse(response.text);

        if (responseJson.errors?.[0]?.error_message) {
            throw new Error(responseJson.errors[0].error_message);
        }

        if (!responseJson.quiz || responseJson.quiz.length === 0) {
            throw new Error("The AI could not generate a quiz from the provided images. The content may be too sparse or unclear.");
        }
        
        setQuestions(responseJson.quiz);
        setAnswerHistory(Array(responseJson.quiz.length).fill('unanswered'));
        setLastQuizSummary(responseJson.summary);
        setSponsoredInsight(responseJson.sponsored_insight);
        setScreen('quiz');
        
    } catch (e: any) {
        console.error(e);
        const errorMessage = e.message?.includes('API key not valid') 
            ? "Your API key is invalid. Please check it and try again."
            : e.message || "The AI engine encountered an issue. Please try again.";
        setError(errorMessage);
        setScreen('home');
    } finally {
        setIsLoading(false);
    }
  };

  const handleGenerateClick = () => {
      if (!apiKey) {
          setError("Please set your API key before generating a quiz.");
          setIsApiKeyModalOpen(true);
          return;
      }
      if (images.length === 0) {
          setError("Please upload at least one image");
          return;
      }
      setError(null);
      setIsSettingsModalOpen(true);
  };

  const handleSettingsSubmit = (settings: QuizSettings) => {
      initAudio();
      setQuizSettings(settings);
      setIsSettingsModalOpen(false);
      setScreen('transition');
      // Use a timeout to allow the screen transition animation to start before the heavy work
      setTimeout(() => generateAndStartQuiz(settings), 100); 
  };

  const handleAnswer = (selectedIndex: number) => {
    if (isAnswered) return;
    setIsAnswered(true);
    setSelectedAnswer(selectedIndex);
    
    const isCorrect = selectedIndex === questions[currentQuestionIndex].correct_index;
    const newHistory = [...answerHistory];
    newHistory[currentQuestionIndex] = isCorrect ? 'correct' : 'incorrect';
    setAnswerHistory(newHistory);

    if (isCorrect) {
      setScore(s => s + 1);
      playSound('correct');
      createParticles();
    } else {
      playSound('wrong');
    }

    setTimeout(() => {
      if (currentQuestionIndex < questions.length - 1) {
        playSound('next');
        setCurrentQuestionIndex(i => i + 1);
      } else {
        setScreen('result');
      }
      setSelectedAnswer(null);
      setIsAnswered(false);
    }, 1500);
  };
  
  const handleCapture = (base64: string) => {
    const newImage: ImageFile = {
        id: `camera-${Date.now()}`,
        name: `capture-${Date.now()}.jpg`,
        type: 'image/jpeg',
        base64,
    };
    setImages(prev => [...prev, newImage]);
    setIsCameraOpen(false);
  };
  
  const handleSelectApiKey = () => {
    setIsApiKeyModalOpen(true);
  };

  const handleSaveApiKey = (key: string) => {
    if (key) {
        setApiKey(key);
        localStorage.setItem('gemini_api_key', key);
    } else {
        setApiKey(null);
        localStorage.removeItem('gemini_api_key');
    }
    setIsApiKeyModalOpen(false);
  };

  const renderScreen = () => {
    switch (screen) {
      case 'transition': return <ProcessingScreen imageCount={images.length} />;
      case 'quiz':
        return (
          <QuizScreen question={questions[currentQuestionIndex]} questionNumber={currentQuestionIndex + 1} totalQuestions={questions.length} onAnswer={handleAnswer}
            selectedAnswer={selectedAnswer} isAnswered={isAnswered} isMuted={isMuted} onMuteToggle={() => setIsMuted(m => !m)} score={score} answerHistory={answerHistory} currentQuestionIndex={currentQuestionIndex} />
        );
      case 'result': return <ResultScreen score={score} total={questions.length} onRetry={resetApp} summary={lastQuizSummary} sponsoredInsight={sponsoredInsight} />;
      case 'home':
      default:
        return (
          <HomeScreen images={images} onAddImageClick={() => fileInputRef.current?.click()} onCameraClick={() => {
              initAudio();
              setIsCameraOpen(true);
            }} onRemoveImage={removeImage} onGenerateClick={handleGenerateClick}
            error={error} isLoading={isLoading} onSelectApiKey={handleSelectApiKey} isApiKeySet={!!apiKey} />
        );
    }
  };

  return (
    <>
      <div id="particle-container"></div>
      {renderScreen()}
      <input type="file" ref={fileInputRef} onChange={handleFileSelect} multiple accept="image/*" style={{ display: 'none' }} />
       <QuizSettingsModal isOpen={isSettingsModalOpen} onClose={() => setIsSettingsModalOpen(false)} onSubmit={handleSettingsSubmit}
        initialSettings={quizSettings} imageCount={images.length} />
       {isCameraOpen && <CameraView onCapture={handleCapture} onClose={() => setIsCameraOpen(false)} />}
       <ApiKeyModal 
         isOpen={isApiKeyModalOpen} 
         onClose={() => setIsApiKeyModalOpen(false)} 
         onSave={handleSaveApiKey} 
         currentKey={apiKey || ''} 
       />
    </>
  );
};

// --- Screen Components ---
const HomeScreen: React.FC<{
  images: ImageFile[], onAddImageClick: () => void, onCameraClick: () => void, onRemoveImage: (id: string) => void, onGenerateClick: () => void, error: string | null, isLoading: boolean, onSelectApiKey: () => void, isApiKeySet: boolean
}> = ({ images, onAddImageClick, onCameraClick, onRemoveImage, onGenerateClick, error, isLoading, onSelectApiKey, isApiKeySet }) => (
  <div className="screen">
     <header className="home-header">
      <button className="lang-toggle" aria-label="Toggle language">EN</button>
      <button className={`api-key-btn ${!isApiKeySet ? 'key-missing' : ''}`} onClick={onSelectApiKey} aria-label="Select API Key">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
        </svg>
      </button>
    </header>
    <div className="holographic-book">
      <div className="book-part back"></div>
      <div className="book-part pages"></div>
      <div className="book-part cover"></div>
    </div>
    <h1>Test Me</h1>
    <p>Upload lesson pages for an instant quiz.</p>
    {error && <p className="error-message">{error}</p>}
    <div className="glass-panel preview-deck">
      {images.length === 0 ? (<p style={{ margin: 'auto' }}>Tap to add a page.</p>) : (
        images.map(img => (
          <div key={img.id} className="preview-tile">
            <img src={`data:${img.type};base64,${img.base64}`} alt={img.name} />
            <button className="remove-btn" onClick={() => onRemoveImage(img.id)}>×</button>
          </div>
        ))
      )}
    </div>
    <div className="action-row">
       <button className="action-btn" onClick={onAddImageClick} aria-label="Add from gallery"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" /></svg></button>
       <button className="action-btn" onClick={onCameraClick} aria-label="Add from camera"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.776 48.776 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" /><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" /></svg></button>
       <button className="action-btn generate-btn" onClick={onGenerateClick} disabled={images.length === 0 || isLoading} aria-label="Generate Quiz"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" /></svg></button>
    </div>
  </div>
);

const HolographicBookModel: React.FC<{ progress: number; }> = ({ progress }) => {
    const mountRef = useRef<HTMLDivElement>(null);
    const animationActions = useRef<{ [key: string]: THREE.AnimationAction | null }>({});
    const lastProgress = useRef(0);

    useEffect(() => {
        if (!mountRef.current) return;

        const currentMount = mountRef.current;
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(50, currentMount.clientWidth / currentMount.clientHeight, 0.1, 1000);
        camera.position.z = 3;
        camera.position.y = 0.5;

        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setSize(currentMount.clientWidth, currentMount.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        currentMount.appendChild(renderer.domElement);
        
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
        scene.add(ambientLight);
        const directionalLight = new THREE.DirectionalLight(0xB77BFF, 3);
        directionalLight.position.set(-5, 5, 5);
        scene.add(directionalLight);
        const directionalLight2 = new THREE.DirectionalLight(0x00E5FF, 3);
        directionalLight2.position.set(5, -5, 2);
        scene.add(directionalLight2);

        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath('https://unpkg.com/three@0.164.1/examples/jsm/libs/draco/gltf/');
        const loader = new GLTFLoader();
        loader.setDRACOLoader(dracoLoader);
        
        let mixer: THREE.AnimationMixer;
        
        const modelUrl = 'https://market.pmnd.rs/models/book.glb';

        loader.load(modelUrl, (gltf) => {
            const model = gltf.scene;
            model.scale.set(2.5, 2.5, 2.5);
            model.position.y = -1.2;
            scene.add(model);
            
            mixer = new THREE.AnimationMixer(model);
            const clips = gltf.animations;

            const idleClip = clips.find(c => c.name === 'idle_breath');
            if (idleClip) {
                const idleAction = mixer.clipAction(idleClip);
                animationActions.current['idle'] = idleAction;
                idleAction.play();
            }
            
            const mergeClip = clips.find(c => c.name === 'merge_accept');
            if (mergeClip) {
                const mergeAction = mixer.clipAction(mergeClip);
                mergeAction.setLoop(THREE.LoopOnce, 1);
                animationActions.current['merge'] = mergeAction;
            }
        }, undefined, (error) => {
            console.error('An error happened while loading the 3D model:', error);
        });

        const clock = new THREE.Clock();
        const animate = () => {
            requestAnimationFrame(animate);
            if(mixer) mixer.update(clock.getDelta());
            renderer.render(scene, camera);
        };
        animate();
        
        const handleResize = () => {
          if (!currentMount) return;
          camera.aspect = currentMount.clientWidth / currentMount.clientHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(currentMount.clientWidth, currentMount.clientHeight);
        };
        
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (currentMount && renderer.domElement) {
                currentMount.removeChild(renderer.domElement);
            }
        };
    }, []);
    
    useEffect(() => {
        if (progress > lastProgress.current) {
            const mergeAction = animationActions.current['merge'];
            if (mergeAction) {
                mergeAction.reset().play();
            }
        }
        lastProgress.current = progress;
    }, [progress]);

    return <div ref={mountRef} className="holographic-book-canvas-container" />;
};


const ProcessingScreen: React.FC<{ imageCount: number; }> = ({ imageCount }) => {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (imageCount === 0) return;
    const timeouts: number[] = [];
    for (let i = 0; i < imageCount; i++) {
        const timeout = window.setTimeout(() => {
            setProgress(p => p + 1);
        }, (i + 1) * 700);
        timeouts.push(timeout);
    }
    
    return () => timeouts.forEach(clearTimeout);
  }, [imageCount]);

  const progressPercentage = imageCount > 0 ? (progress / imageCount) * 100 : 0;
  
  return (
    <div className="screen processing-screen">
       <div className="processing-particles">
        {Array.from({ length: 20 }).map((_, i) => <div key={i} className="p-particle"></div>)}
      </div>

      <div className="sponsored-insight-card">
        <div className="sponsored-thumb">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M4.5 3.75a3 3 0 00-3 3v10.5a3 3 0 003 3h15a3 3 0 003-3V6.75a3 3 0 00-3-3h-15zm4.125 3.375a.75.75 0 01.75 0l5.25 3.375a.75.75 0 010 1.25l-5.25 3.375a.75.75 0 01-1.125-.625V7.5a.75.75 0 01.375-.625z" /></svg>
        </div>
        <div className="sponsored-text">
          <p className="sponsored-label">Sponsored Insight</p>
          <p>Learn quantum physics faster with interactive simulations.</p>
        </div>
      </div>

      <main className="processing-animation-container">
        <HolographicBookModel progress={progress} />
        {Array.from({ length: imageCount }).map((_, i) => (
          <div 
            key={i} 
            className="page-tile" 
            style={{ 
              animationDelay: `${i * 0.5}s`,
              opacity: progress > i ? 0 : 1 
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M1 5.25A2.25 2.25 0 013.25 3h13.5A2.25 2.25 0 0119 5.25v9.5A2.25 2.25 0 0116.75 17H3.25A2.25 2.25 0 011 14.75v-9.5zm1.5 5.81v3.69c0 .414.336.75.75.75h13.5a.75.75 0 00.75-.75v-3.69l-2.72-2.72a.75.75 0 00-1.06 0L11.5 11.25l-1.72-1.72a.75.75 0 00-1.06 0l-2.97 2.97zM10.25 7a.75.75 0 01.75.75v.008a.75.75 0 01-1.5 0V7.75a.75.75 0 01.75-.75z" clipRule="evenodd" /></svg>
          </div>
        ))}
      </main>

      <footer className="processing-footer">
        <p className="progress-text">{ `Integrating data: ${progress} / ${imageCount} pages`}</p>
        <div className="processing-progress-bar">
          <div className="processing-progress-bar-inner" style={{ width: `${progressPercentage}%` }}></div>
        </div>
        <p className="engine-attribution">Powered by Test Me Quantum Engine</p>
      </footer>
    </div>
  );
};


const QuizScreen: React.FC<{
  question: QuizQuestion, questionNumber: number, totalQuestions: number, onAnswer: (index: number) => void,
  selectedAnswer: number | null, isAnswered: boolean, isMuted: boolean, onMuteToggle: () => void, score: number, answerHistory: AnswerStatus[],
  currentQuestionIndex: number
}> = ({ question, questionNumber, totalQuestions, onAnswer, selectedAnswer, isAnswered, isMuted, onMuteToggle, score, answerHistory, currentQuestionIndex }) => {
    const getButtonClass = (index: number) => {
        if (!isAnswered) return '';

        const isUserSelection = index === selectedAnswer;
        const isCorrectAnswer = index === question.correct_index;
        const wasAnswerCorrect = selectedAnswer === question.correct_index;

        if (isUserSelection) {
            return wasAnswerCorrect ? 'correct' : 'wrong';
        }

        // If the user answered wrong, highlight the correct answer
        if (!wasAnswerCorrect && isCorrectAnswer) {
            return 'correct-answer-highlight';
        }

        return '';
    };
    
    const wasAnswerCorrect = selectedAnswer === question.correct_index;

  return (
    <div className="screen quiz-screen">
      <header style={{ width: '100%' }}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem'}}>
            <p>Question {questionNumber} / {totalQuestions}</p>
            <div style={{display: 'flex', alignItems: 'center', gap: '1rem'}}>
                <span className="difficulty-badge">{question.difficulty}</span>
                <button onClick={onMuteToggle} className="mute-btn">
                    {isMuted ? <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.531V19.94a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.506-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.395C2.806 8.757 3.63 8.25 4.51 8.25H6.75z" /></svg> : <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>}
                </button>
            </div>
        </div>
        <div className="progress-dots">
            {answerHistory.map((status, index) => {
                const isCurrent = index === currentQuestionIndex;
                return (
                    <div
                      key={index}
                      className={`progress-dot-container ${isCurrent ? 'current' : ''}`}
                    >
                      <div
                        className={`progress-dot ${status}`}
                        aria-label={`Question ${index + 1} status: ${status}`}
                      >
                        {status === 'correct' && (
                          <svg className="progress-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.052-.143z" clipRule="evenodd" />
                          </svg>
                        )}
                        {status === 'incorrect' && (
                           <svg className="progress-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                          </svg>
                        )}
                      </div>
                    </div>
                );
            })}
        </div>
        <div className="xp-bar"><div className="xp-bar-inner" style={{ width: `${(score / totalQuestions) * 100}%` }}></div></div>
      </header>
      <main key={questionNumber} className="quiz-main" style={{flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '100%', gap: '1rem'}}>
        <h2 className="quiz-question-text" style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>{question.question_text}</h2>
        <div className="quiz-options-container">
            {question.options.map((option, index) => (
                <button
                    key={index}
                    className={`btn quiz-option ${getButtonClass(index)}`}
                    onClick={() => onAnswer(index)}
                    disabled={isAnswered}
                    style={{ animationDelay: `${150 + index * 100}ms` }}
                >
                    {option}
                </button>
            ))}
        </div>
         {isAnswered && !wasAnswerCorrect && (<div className="explanation-panel"><p><strong>Explanation:</strong> {question.explanation}</p></div>)}
      </main>
    </div>
  );
};

// Helper function to wrap text on a canvas
const wrapCanvasText = (context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) => {
    const words = text.split(' ');
    let line = '';
    for(let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + ' ';
        const metrics = context.measureText(testLine);
        const testWidth = metrics.width;
        if (testWidth > maxWidth && n > 0) {
            context.fillText(line, x, y);
            line = words[n] + ' ';
            y += lineHeight;
        } else {
            line = testLine;
        }
    }
    context.fillText(line, x, y);
};


const ResultScreen: React.FC<{
  score: number, total: number, onRetry: () => void, summary: string | null, sponsoredInsight: string | null
}> = ({ score, total, onRetry, summary, sponsoredInsight }) => {
    const [displayedScore, setDisplayedScore] = useState(0);
    const [isSharing, setIsSharing] = useState(false);

    useEffect(() => {
        if (score === 0) return;
        const duration = 1200; // ms
        const startTime = performance.now();

        const animateScore = (currentTime: number) => {
            const elapsedTime = currentTime - startTime;
            const progress = Math.min(elapsedTime / duration, 1);
            const easedProgress = 1 - Math.pow(1 - progress, 3); // easeOutCubic
            const currentDisplay = Math.round(easedProgress * score);
            setDisplayedScore(currentDisplay);

            if (progress < 1) {
                requestAnimationFrame(animateScore);
            } else {
                setDisplayedScore(score);
            }
        };
        requestAnimationFrame(animateScore);
    }, [score]);


    const generateShareImage = (): Promise<File> => {
        return new Promise((resolve, reject) => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                return reject(new Error('Could not get canvas context'));
            }

            const width = 1080;
            const height = 1080;
            canvas.width = width;
            canvas.height = height;

            // --- Drawing Styles ---
            const bgColor = '#0B0F1A';
            const textColor = '#E0E0E0';
            const primaryAccent = '#87CEEB';
            const surfaceColor = 'rgba(25, 25, 45, 0.8)';

            // 1. Background
            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, width, height);
            const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, width / 1.5);
            gradient.addColorStop(0, 'rgba(135, 206, 235, 0.15)');
            gradient.addColorStop(1, 'rgba(135, 206, 235, 0)');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, width, height);

            // 2. Title
            ctx.font = 'bold 96px Poppins';
            ctx.fillStyle = primaryAccent;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.shadowColor = 'rgba(135, 206, 235, 0.5)';
            ctx.shadowBlur = 20;
            ctx.fillText('Test Me', width / 2, 80);
            ctx.shadowBlur = 0;

            // 3. Quiz Topic
            ctx.font = '48px Poppins';
            ctx.fillStyle = textColor;
            if (summary) {
                wrapCanvasText(ctx, `Quiz on: "${summary}"`, width / 2, 230, width - 160, 60);
            }

            // 4. Circular Progress Bar
            const centerX = width / 2;
            const centerY = height / 2 + 80;
            const radius = 250;
            const lineWidth = 60;
            const percentage = total > 0 ? score / total : 0;
            const endAngle = (Math.PI * 2 * percentage) - (Math.PI / 2);

            ctx.lineWidth = lineWidth;
            // Background track
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            ctx.strokeStyle = surfaceColor;
            ctx.stroke();

            // Progress arc
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, -Math.PI / 2, endAngle);
            ctx.strokeStyle = primaryAccent;
            ctx.lineCap = 'round';
            ctx.stroke();

            // 5. Score Text
            ctx.fillStyle = textColor;
            ctx.textBaseline = 'middle';
            ctx.font = 'bold 160px Poppins';
            ctx.fillText(`${score}/${total}`, centerX, centerY);
            
            ctx.font = '48px Poppins';
            ctx.fillText('Correct', centerX, centerY + 150);

            // 6. Convert to file and resolve
            canvas.toBlob((blob) => {
                if (blob) {
                    const file = new File([blob], 'quiz-result.png', { type: 'image/png' });
                    resolve(file);
                } else {
                    reject(new Error('Canvas to Blob conversion failed'));
                }
            }, 'image/png', 0.95);
        });
    };

  const handleShare = async () => {
    if (!summary || !navigator.share) return;

    setIsSharing(true);
    try {
        const imageFile = await generateShareImage();
        const shareData = {
            title: 'My Test Me Quiz Result!',
            text: `I scored ${score}/${total} on a quiz about "${summary}" using the Test Me app!`,
            files: [imageFile],
        };

        if (navigator.canShare && navigator.canShare({ files: [imageFile] })) {
            await navigator.share(shareData);
        } else {
            // Fallback for browsers that don't support file sharing
            await navigator.share({ title: shareData.title, text: shareData.text });
        }
    } catch (err) {
      console.error('Share failed:', err);
    } finally {
        setIsSharing(false);
    }
  };

  return (
    <div className="screen result-screen">
      <h1>Quiz Complete!</h1>
      <div className="glass-panel score-panel">
        <h2 style={{fontSize: '3rem', color: 'var(--primary-accent)'}}>{displayedScore} / {total}</h2>
        <p>Correct Answers</p>
      </div>
      {summary && (
        <div className="glass-panel summary-panel" style={{textAlign: 'left'}}>
            <h3 style={{marginBottom: '0.5rem', color: 'var(--primary-accent)'}}>Study Summary</h3>
            <p style={{color: 'var(--text-color)'}}>{summary}</p>
        </div>
      )}
      {sponsoredInsight && (
        <div className="sponsored-insight-result">
          <div className="sponsored-thumb-result">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.25a.75.75 0 01.75.75v2.25a.75.75 0 01-1.5 0V3a.75.75 0 01.75-.75zM7.5 12a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM18.894 6.106a.75.75 0 010 1.06l-1.591 1.59a.75.75 0 11-1.06-1.061l1.59-1.591a.75.75 0 011.06 0zM21.75 12a.75.75 0 01-.75.75h-2.25a.75.75 0 010-1.5H21a.75.75 0 01.75.75zM17.803 17.803a.75.75 0 01-1.06 0l-1.59-1.591a.75.75 0 111.06-1.06l1.59 1.59a.75.75 0 010 1.06zM12 21.75a.75.75 0 01-.75-.75v-2.25a.75.75 0 011.5 0V21a.75.75 0 01-.75-.75zM6.106 18.894a.75.75 0 011.06 0l1.59-1.59a.75.75 0 111.06 1.06l-1.59 1.591a.75.75 0 01-1.06 0zM3 12a.75.75 0 01.75-.75h2.25a.75.75 0 010 1.5H3.75a.75.75 0 01-.75-.75zM6.197 7.197a.75.75 0 010-1.06l1.59-1.591a.75.75 0 111.06 1.06l-1.59 1.59a.75.75 0 01-1.06 0z" /></svg>
          </div>
          <div className="sponsored-text-result">
            <p className="sponsored-label-result">Sponsored Insight</p>
            <p>{sponsoredInsight}</p>
          </div>
        </div>
      )}
      <div className="result-actions">
        <button className="btn btn-primary" onClick={onRetry}>Play Again</button>
        {navigator.share && (
          <button className="btn btn-secondary" onClick={handleShare} disabled={isSharing}>
            {isSharing ? 'Generating...' : (
                <>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 100-2.186m0 2.186c-.18.324-.283.696-.283 1.093s.103.77.283 1.093m0-2.186l-9.566-5.314" />
                </svg>
                Share
                </>
            )}
          </button>
        )}
      </div>
    </div>
  );
};

const CameraView: React.FC<{ onCapture: (base64: string) => void; onClose: () => void }> = ({ onCapture, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const openCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error("Error accessing camera:", err);
        setError("Could not access the camera. Please check permissions.");
      }
    };
    openCamera();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const handleCaptureClick = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (context) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg');
        const base64 = dataUrl.split(',')[1];
        onCapture(base64);
    }
  };

  return (
    <div className="camera-overlay">
      {error ? (
        <div className="camera-error">
          <p>{error}</p>
          <button onClick={onClose} className="btn">Close</button>
        </div>
      ) : (
        <>
          <video ref={videoRef} autoPlay playsInline className="camera-feed"></video>
          <canvas ref={canvasRef} style={{ display: 'none' }}></canvas>
          <button className="camera-close-btn" onClick={onClose} aria-label="Close camera">×</button>
          <div className="camera-controls">
            <button className="camera-capture-btn" onClick={handleCaptureClick} aria-label="Capture photo"></button>
          </div>
        </>
      )}
    </div>
  );
};

const QuizSettingsModal: React.FC<{
  isOpen: boolean; onClose: () => void; onSubmit: (settings: QuizSettings) => void; initialSettings: QuizSettings; imageCount: number;
}> = ({ isOpen, onClose, onSubmit, initialSettings, imageCount }) => {
  const [questionCount, setQuestionCount] = useState(initialSettings.questionCount);
  const [difficulty, setDifficulty] = useState(initialSettings.difficulty);
  const modalRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setQuestionCount(initialSettings.questionCount); setDifficulty(initialSettings.difficulty); }, [initialSettings]);
  useEffect(() => { if (isOpen) { modalRef.current?.focus(); } }, [isOpen]);
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === 'Escape') { onClose(); } };
  const handleSubmit = () => onSubmit({ questionCount, difficulty });
  if (!isOpen) return null;
  return (
    <div className="modal-overlay" onKeyDown={handleKeyDown}>
      <div className="modal-content glass-panel" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal-header"><h2 id="modal-title">Quiz Settings</h2><button className="close-btn" onClick={onClose}>×</button></header>
        <p className="modal-subtitle">Configure your quiz preferences</p>
        <div className="modal-body">
          <div className="form-group">
            <label htmlFor="question-count">Questions</label>
            <div className="slider-container">
                <input type="range" id="question-count" min="1" max="60" step="1" value={questionCount} onChange={(e) => setQuestionCount(parseInt(e.target.value))} />
                <span className="slider-value">{questionCount}</span>
            </div>
            <div className="presets">{[5, 10, 20, 60].map(p => <button key={p} onClick={() => setQuestionCount(p)}>{p}</button>)}</div>
          </div>
          <div className="form-group">
             <label htmlFor="difficulty">Difficulty</label>
             <select id="difficulty" value={difficulty} onChange={e => setDifficulty(e.target.value as QuizSettings['difficulty'])}>
                 <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
             </select>
          </div>
          {imageCount === 0 && <p className="error-message" style={{fontSize: '0.8rem'}}>Add at least one image to continue.</p>}
        </div>
        <footer className="modal-footer"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={handleSubmit} disabled={imageCount === 0}>Start Quiz</button></footer>
      </div>
    </div>
  );
};

const ApiKeyModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSave: (key: string) => void;
  currentKey: string;
}> = ({ isOpen, onClose, onSave, currentKey }) => {
  const [keyInput, setKeyInput] = useState(currentKey);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setKeyInput(currentKey);
  }, [currentKey, isOpen]);

  useEffect(() => {
    if (isOpen) {
      modalRef.current?.focus();
    }
  }, [isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const handleSave = () => {
    onSave(keyInput);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onKeyDown={handleKeyDown}>
      <div className="modal-content glass-panel" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="api-modal-title">
        <header className="modal-header">
          <h2 id="api-modal-title">Set API Key</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="form-group">
            <label htmlFor="api-key-input">Your Gemini API Key</label>
            <input
              id="api-key-input"
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Enter your API key here"
              className="api-key-input"
            />
          </div>
          <div className="api-instructions">
            <p>Your API key is stored locally in your browser and is never sent to our servers.</p>
            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">
              Get an API key from Google AI Studio
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-4.5 0V6.375c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125-1.125h-4.5A1.125 1.125 0 0113.5 10.5m0 0h-4.5" />
              </svg>
            </a>
          </div>
        </div>
        <footer className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save Key</button>
        </footer>
      </div>
    </div>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);