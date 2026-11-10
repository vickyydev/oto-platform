import { HelpCircle } from 'lucide-react';
import { openQuestionText, type OpenQuestion } from '@/lib/open-question';

/**
 * SCRUM-831: under an assistant line that asked the customer something, what
 * it asked and what it read the reply as — "asked: child's age · answered 8"
 * — so staff see what the assistant believes, and can correct it. Small and
 * muted, on the line's side; nothing when the line asked nothing.
 */
export function OpenQuestionLine({ questions }: { questions: readonly OpenQuestion[] }) {
  if (questions.length === 0) return null;
  return (
    <div className="-mt-1 flex justify-end" data-testid="open-question">
      <div className="flex min-w-0 max-w-[80%] flex-wrap justify-end gap-x-3 gap-y-0.5 text-[11px] text-indigo-500/80 dark:text-indigo-300/70">
        {questions.map((q) => (
          <span key={q.id} className="inline-flex items-center gap-1" data-slot={q.slot} data-state={q.state}>
            <HelpCircle className="h-3 w-3 shrink-0" />
            {openQuestionText(q)}
          </span>
        ))}
      </div>
    </div>
  );
}
