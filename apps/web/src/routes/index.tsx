import { createFileRoute } from '@tanstack/react-router';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>PDF Fixtures 產生器</CardTitle>
        <CardDescription>
          用假資料大量產生 PDF 測試檔，每份附上逐頁的標準答案（gt.json）。
        </CardDescription>
      </CardHeader>
      <CardContent className="text-muted-foreground text-sm">
        樣板管理與批次產出的頁面還在建置中。
      </CardContent>
    </Card>
  );
}
