/** Compatibility for previously saved workbench clients; use the existing quota-checked intake. */
import { POST as existingUpload } from '@/app/api/uploads/route';
export const dynamic='force-dynamic';
export const maxDuration=60;
export const POST=existingUpload;
