// 站点全局配置 — 所有可配置项集中在这里

export const SITE_TITLE = "cafeawa's Blog";
export const SITE_DESCRIPTION = '技术 · 生活 · 随便写写';

export const SITE_AUTHOR = 'cafeawa';

// 导航栏菜单项
export const NAV_ITEMS = [
	{ href: '/', label: '首页' },
	{ href: '/blog', label: '博客' },
	{ href: '/tags', label: '标签' },
	{ href: '/archive', label: '归档' },
	{ href: '/friends', label: '友链' },
	{ href: '/about', label: '关于' },
];

// 社交链接
export const SOCIAL_LINKS = [
	{
		name: 'GitHub',
		href: 'https://github.com/cafeawa',
		icon: 'github',
	},
];

// 页脚
export const FOOTER = {
	copyright: 'cafeawa',
	icp: '粤ICP备2026048231号-1',
	icpUrl: 'https://beian.miit.gov.cn/',
};

// 首页 Hero
export const HERO = {
	greeting: '你好，我是 cafeawa 👋',
	subtitle: '一个热爱技术和生活的开发者，在这里记录所学所想。',
};

// 分页
export const POSTS_PER_PAGE = 6;

// Waline 评论
export const WALINE_SERVER_URL = 'http://localhost:8360';
