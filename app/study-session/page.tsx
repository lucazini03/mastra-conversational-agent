'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, Suspense } from 'react';

function StudySessionContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const topic = searchParams.get('topic') ?? 'Unknown Topic';
  const durationMinutes = Number(searchParams.get('duration') ?? '5');

  const totalSeconds = durationMinutes * 60;
  const [secondsLeft, setSecondsLeft] = useState(totalSeconds);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(intervalRef.current!);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const minutes = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const seconds = String(secondsLeft % 60).padStart(2, '0');
  const isFinished = secondsLeft === 0;

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <p style={styles.label}>Study Session</p>
        <h1 style={styles.topic}>{topic}</h1>

        <div style={styles.timerContainer}>
          {isFinished ? (
            <span style={styles.timerFinished}>Time&apos;s up!</span>
          ) : (
            <span style={styles.timer}>
              {minutes}:{seconds}
            </span>
          )}
        </div>

        <button style={styles.button} onClick={() => router.push('/')}>
          Go Back
        </button>
      </div>
    </div>
  );
}

export default function StudySessionPage() {
  return (
    <Suspense>
      <StudySessionContent />
    </Suspense>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0f0f0f',
    fontFamily: 'system-ui, sans-serif',
  },
  card: {
    textAlign: 'center',
    padding: '3rem 4rem',
    background: '#1a1a1a',
    borderRadius: '1.5rem',
    border: '1px solid #2a2a2a',
    maxWidth: '600px',
    width: '90%',
  },
  label: {
    margin: '0 0 0.5rem',
    fontSize: '0.9rem',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: '#888',
  },
  topic: {
    margin: '0 0 2.5rem',
    fontSize: '2.5rem',
    fontWeight: 700,
    color: '#ffffff',
    lineHeight: 1.2,
  },
  timerContainer: {
    marginBottom: '2.5rem',
  },
  timer: {
    fontSize: '5rem',
    fontWeight: 800,
    fontVariantNumeric: 'tabular-nums',
    color: '#4ade80',
    letterSpacing: '-0.02em',
  },
  timerFinished: {
    fontSize: '3rem',
    fontWeight: 700,
    color: '#f87171',
  },
  button: {
    padding: '0.75rem 2rem',
    fontSize: '1rem',
    fontWeight: 600,
    color: '#fff',
    background: '#333',
    border: '1px solid #444',
    borderRadius: '0.75rem',
    cursor: 'pointer',
  },
};
