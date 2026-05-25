import { AlertTriangle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { LargeFileState } from '@/hooks/useEditor';
import { useI18n } from '@/i18n';

interface LargeFileAlertDialogProps {
  state: LargeFileState | null;
  onConfirm: (mode: 'full' | 'partial') => void;
  onCancel: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LargeFileAlertDialog({ state, onConfirm, onCancel }: LargeFileAlertDialogProps) {
  const { t } = useI18n();

  return (
    <AlertDialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            {t('Large File')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {state &&
              t(
                'This file is {{size}}, which may cause the editor to lag. How would you like to proceed?',
                {
                  size: formatBytes(state.size),
                }
              )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            {t("Don't Open")}
          </AlertDialogClose>
          <Button variant="secondary" onClick={() => onConfirm('partial')}>
            {t('View First 1000 Lines')}
          </Button>
          <Button variant="default" onClick={() => onConfirm('full')}>
            {t('Open Anyway')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
