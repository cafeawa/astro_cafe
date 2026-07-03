import { getCollection } from 'astro:content';

/** 获取所有已发布文章，按日期降序 */
export async function getPublishedPosts() {
	const posts = await getCollection('blog');
	return posts
		.filter((post) => !post.data.draft)
		.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** 获取所有标签及其文章数 */
export async function getAllTags() {
	const posts = await getPublishedPosts();
	const tagMap = new Map<string, number>();

	for (const post of posts) {
		for (const tag of post.data.tags) {
			tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
		}
	}

	return [...tagMap.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([name, count]) => ({ name, count }));
}

/** 按年份分组文章 */
export async function getPostsByYear() {
	const posts = await getPublishedPosts();
	const yearMap = new Map<number, typeof posts>();

	for (const post of posts) {
		const year = post.data.pubDate.getFullYear();
		if (!yearMap.has(year)) yearMap.set(year, []);
		yearMap.get(year)!.push(post);
	}

	return [...yearMap.entries()].sort((a, b) => b[0] - a[0]);
}

/** 获取精选/最新的 N 篇文章 */
export async function getRecentPosts(n = 6) {
	const posts = await getPublishedPosts();
	return posts.slice(0, n);
}

/** 按标签筛选文章 */
export async function getPostsByTag(tag: string) {
	const posts = await getPublishedPosts();
	return posts.filter((post) => post.data.tags.includes(tag));
}
