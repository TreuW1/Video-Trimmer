import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const prerender = true;

export const GET: RequestHandler = async () => {
	// Return empty JSON response for Chrome DevTools well-known request
	// This prevents 404 errors from being logged
	return json({});
};

