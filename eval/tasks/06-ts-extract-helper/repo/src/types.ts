export interface Author {
  id: number;
  displayName: string;
  email: string;
}

export interface Tag {
  slug: string;
  name: string;
}

export interface Post {
  id: number;
  title: string;
  slug: string;
  body: string;
  authorId: number;
  tags: Tag[];
  publishedAt: Date | null;
}

export interface PostInput {
  title: string;
  body: string;
  authorId: number;
  tags?: string[];
}
