# inkwell

The content model behind the blog: posts, tags, authors and their public URLs.

- `src/posts.ts` creating posts, post slugs (made unique with `-2`, `-3`, ...) and excerpts
- `src/tags.ts` tag slugs and de-duplicating free-text tags
- `src/authors.ts` author handles and bylines
- `src/urls.ts` public URLs for posts, tags and authors

Slugs are lowercase ASCII words joined by `-`: accents are dropped, `&` becomes
`and`, apostrophes disappear. Post slugs are at most 60 characters, tag slugs 32
and author handles 40.

```
bun test
```
