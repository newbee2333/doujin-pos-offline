/** 按分类渲染克制的几何线框缺省封面，替代灰底「无图片」文字。 */
export function CategoryPlaceholder({
  categoryName,
  alt,
  className
}: {
  categoryName?: string | null;
  alt?: string;
  className?: string;
}) {
  const name = (categoryName ?? '').trim();
  const cls = className ? `thumb-placeholder cat-placeholder ${className}` : 'thumb-placeholder cat-placeholder';

  let icon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M4 15.5l4.2-4.2a1.2 1.2 0 0 1 1.7 0L14 15.5" />
      <path d="M12.5 14l1.8-1.8a1.2 1.2 0 0 1 1.7 0L20 16" />
      <circle cx="9" cy="9" r="1.2" />
    </svg>
  );

  if (name.includes('新刊')) {
    icon = (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v17H6.5A1.5 1.5 0 0 1 5 18.5v-14Z" />
        <path d="M5 17.5A1.5 1.5 0 0 1 6.5 16H19" />
        <path d="M14 3v6l2-1.4L18 9V3" />
      </svg>
    );
  } else if (name.includes('既刊') || name.includes('本')) {
    icon = (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="5" width="5" height="15" rx="1" />
        <rect x="9.5" y="4" width="5" height="16" rx="1" />
        <path d="M15 6.5l4.2-1 2.2 13.8-4.2 1z" />
      </svg>
    );
  } else if (name.includes('亚克力') || name.includes('立牌')) {
    icon = (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 4h8l1.5 13h-11L8 4Z" />
        <ellipse cx="12" cy="18.5" rx="6.5" ry="2" />
      </svg>
    );
  } else if (name.includes('徽章') || name.includes('吧唧')) {
    icon = (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 7.5v1.5M12 15v1.5M7.5 12H9M15 12h1.5" />
      </svg>
    );
  } else if (name.includes('色纸') || name.includes('明信片')) {
    icon = (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="1.5" />
        <rect x="7" y="7" width="10" height="10" rx="0.8" />
      </svg>
    );
  } else if (name.includes('套装')) {
    icon = (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="9" width="16" height="11" rx="2" />
        <path d="M3 9h18M12 9v11" />
        <path d="M12 9H8.8a2.2 2.2 0 1 1 0-4.4C10.8 4.6 12 9 12 9Z" />
        <path d="M12 9h3.2a2.2 2.2 0 1 0 0-4.4C13.2 4.6 12 9 12 9Z" />
      </svg>
    );
  } else if (name.includes('无料') || name.includes('赠')) {
    icon = (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4V7Z" />
        <path d="M10 5v14" strokeDasharray="2.5 2.5" />
      </svg>
    );
  }

  return (
    <div className={cls} role="img" aria-label={alt || name || '暂无封面'}>
      {icon}
      <span>{name || '暂无封面'}</span>
    </div>
  );
}
