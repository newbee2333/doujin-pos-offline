import { useNavigate } from 'react-router-dom';
import manualHtml from 'virtual:manual-html';

/**
 * 应用内说明书。
 *
 * 内容不是手抄的一份，而是构建期直接从仓库 README.md 转换来的——
 * 用户手册的正文只有 README 一处，网页里显示的、GitHub 首页显示的、
 * 应用里显示的永远是同一份，改手册不需要同步三个地方。
 */
export default function HelpPage() {
  const navigate = useNavigate();
  return (
    <div className="kiosk">
      <div className="kiosk-header">
        <button className="small ghost" onClick={() => navigate(-1)}>
          ‹ 返回
        </button>
        <span className="title">使用说明书</span>
      </div>
      <div className="content">
        <div
          className="manual"
          // 内容来自构建期对自家 README 的转换，不含任何用户输入
          dangerouslySetInnerHTML={{ __html: manualHtml }}
        />
      </div>
    </div>
  );
}
