// api/fetch-rss.js

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const Parser = require('rss-parser');
const parser = new Parser();
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin SDK 초기화
try {
    // 환경 변수에서 서비스 계정 정보 가져오기
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY_JSON);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK 초기화 성공');
} catch (error) {
    console.error('Firebase Admin SDK 초기화 실패:', error);
}

const CHALLENGE_EPOCH_START_DATE_STRING = '2025-05-10T00:00:00+09:00'; // 챌린지 대주기 시작일 (KST)
const CHALLENGE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000; // 2주를 밀리초로

function isValidDate(dateString) {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');  // JSON 응답임을 명시
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (!admin.apps.length) {
        console.error('Firebase Admin SDK가 초기화되지 않아 함수를 실행할 수 없습니다.');
        return res.status(500).json({ error: '서버 내부 오류: Firebase 설정 문제' });
    }
    const db = admin.firestore();

    // URL 파라미터에서 RSS URL 가져오기
    const rssUrl = req.query.url;
    if (rssUrl) {
        // 단일 블로그 RSS 가져오기
        try {
            console.log(`단일 블로그 RSS 가져오기 시작: ${rssUrl}`);
            const feed = await parser.parseURL(rssUrl);
            console.log(`RSS 가져오기 성공: ${feed.title}`);

            if (!feed.items || feed.items.length === 0) {
                return res.status(200).json({ error: '피드에 아이템 없음' });
            }

            // 날짜순으로 정렬 (최신순)
            const sortedItems = feed.items.sort((a, b) => {
                const dateA = new Date(a.isoDate || a.pubDate);
                const dateB = new Date(b.isoDate || b.pubDate);
                return dateB - dateA;
            });

            return res.status(200).json({
                feedTitle: feed.title,
                items: sortedItems.map(item => ({
                    title: item.title || "제목 없음",
                    link: item.link || "#",
                    date: item.isoDate || item.pubDate || "",
                    snippet: item.contentSnippet ? item.contentSnippet.slice(0, 150) + '...' : ''
                }))
            });
        } catch (error) {
            console.error('RSS 가져오기 오류:', error);
            return res.status(500).json({ error: 'RSS 가져오기 실패', details: error.message });
        }
    }

    // 전체 블로그 업데이트 로직
    console.log('모든 블로그 정보 업데이트 시작 (특별 과제 로직 포함)...');
    let successfulRssUpdates = 0;
    let failedRssUpdates = 0;
    const blogsDataForRanking = [];

    try {
        const blogsRef = db.collection('blogs');
        const blogsSnapshot = await blogsRef.get();

        if (blogsSnapshot.empty) {
            return res.status(200).json({ message: '등록된 블로그 없음', updatedCount: 0, errorCount: 0 });
        }

        const epochStartDate = new Date(CHALLENGE_EPOCH_START_DATE_STRING);
        const now = new Date();

        const blogProcessingPromises = blogsSnapshot.docs.map(async (doc) => {
            const blogData = doc.data();
            const blogId = doc.id;
            const blogName = blogData.name || blogId;
            const rssUrl = blogData.rss_feed_url;
            let writeOperations = {};
            
            // Firestore의 현재 값을 기준으로 final 변수들 초기화
            let finalChallengePosts = blogData.challengePosts || 0;
            let finalIsActive = blogData.isActive === undefined ? false : blogData.isActive;
            let finalSuccessCount = blogData.challengeSuccessCount || 0;
            let finalFailureCount = blogData.challengeFailureCount || 0;
            let finalSpecialMissionCompleted = true; // 모든 블로그의 특별 과제를 완료 상태로 설정

            if (!rssUrl) {
                console.warn(`블로그 [${blogName}] RSS URL 없음.`);
                failedRssUpdates++;
                try { await blogsRef.doc(blogId).update({ rssFetchError: 'RSS URL 없음', lastRssFetchAttemptAt: admin.firestore.FieldValue.serverTimestamp() }); }
                catch (err) { console.error(`[${blogId}] Firestore 오류 기록 실패 (RSS URL 없음):`, err.message); }
                blogsDataForRanking.push({ id: blogId, name: blogName, challengePosts: finalChallengePosts, isActive: finalIsActive, challengeSuccessCount: finalSuccessCount, challengeFailureCount: finalFailureCount, specialMissionCompleted: finalSpecialMissionCompleted });
                return;
            }

            console.log(`[${blogName}] 처리 시작: ${rssUrl}`);
            try {
                const feed = await parser.parseURL(rssUrl);
                console.log(`[${blogName}] RSS 가져오기 성공: ${feed.title}`);
                writeOperations = {};

                if (!feed.items || feed.items.length === 0) {
                    writeOperations.rssFetchError = '피드에 아이템 없음';
                    finalIsActive = false;
                    writeOperations.isActive = finalIsActive;
                    writeOperations.lastRssFetchAttemptAt = admin.firestore.FieldValue.serverTimestamp();
                } else {
                    let calculatedGeneralChallengePosts = 0;
                    let latestPostDateObjInFeed = null;
                    const postsForGeneralChallenge = [];
                    let foundFirstPost = false;
                    let foundSecondPost = false;
                    const isBupyeongCampus = blogName.includes('부천범박');  // 부천범박 캠퍼스 여부 확인

                    // 날짜순으로 정렬 (최신순)
                    const sortedItems = feed.items.sort((a, b) => {
                        const dateA = new Date(a.isoDate || a.pubDate);
                        const dateB = new Date(b.isoDate || b.pubDate);
                        return dateB - dateA;
                    });

                    sortedItems.forEach(item => {
                        const postDateISO = item.isoDate || item.pubDate;
                        if (isValidDate(postDateISO)) {
                            const postDateObj = new Date(postDateISO);
                            if (!latestPostDateObjInFeed || postDateObj > latestPostDateObjInFeed) {
                                latestPostDateObjInFeed = postDateObj;
                            }

                            if (postDateObj >= epochStartDate) {
                                if (isBupyeongCampus) {
                                    console.log(`[${blogName}] 포스팅 처리: ${postDateObj.toISOString()}, foundFirstPost: ${foundFirstPost}, foundSecondPost: ${foundSecondPost}`);
                                }
                                if (!foundFirstPost) {
                                    foundFirstPost = true;
                                    if (isBupyeongCampus) {
                                        console.log(`[${blogName}] 첫 번째 포스팅 건너뜀: ${postDateObj.toISOString()}`);
                                    }
                                } else if (isBupyeongCampus && !foundSecondPost) {
                                    foundSecondPost = true;
                                    console.log(`[${blogName}] 두 번째 포스팅 건너뜀: ${postDateObj.toISOString()}`);
                                } else {
                                    calculatedGeneralChallengePosts++;
                                    postsForGeneralChallenge.push(postDateObj);
                                    if (isBupyeongCampus) {
                                        console.log(`[${blogName}] 챌린지 포스팅으로 카운트: ${postDateObj.toISOString()}`);
                                    }
                                }
                            }
                        }
                    });

                    finalChallengePosts = calculatedGeneralChallengePosts;
                    if (isBupyeongCampus) {
                        console.log(`[${blogName}] 최종 챌린지 포스팅 수: ${finalChallengePosts}`);
                    }

                    writeOperations.lastPostDate = latestPostDateObjInFeed ? latestPostDateObjInFeed.toISOString() : (blogData.lastPostDate || "");
                    writeOperations.posts = feed.items.slice(0, 5).map(item => ({
                        title: item.title || "제목 없음", link: item.link || "#",
                        date: item.isoDate || item.pubDate || "",
                        snippet: item.contentSnippet ? item.contentSnippet.slice(0, 150) + '...' : ''
                    }));
                    writeOperations.challengePosts = finalChallengePosts;
                    writeOperations.specialMissionCompleted = finalSpecialMissionCompleted; // 특별 과제 완료 상태 유지
                    writeOperations.rssFetchError = null;
                    writeOperations.lastRssFetchSuccessAt = admin.firestore.FieldValue.serverTimestamp();

                    // --- 일반 챌린지 기간별 성공/실패 누적 ---
                    let successCount = blogData.challengeSuccessCount || 0;
                    let failureCount = blogData.challengeFailureCount || 0;
                    let lastProcessed = blogData.lastProcessedPeriodEndDate ? new Date(blogData.lastProcessedPeriodEndDate) : null;
                    let periodIteratorStart = lastProcessed ? new Date(lastProcessed.getTime() + 1) : new Date(epochStartDate.getTime());

                    while (periodIteratorStart < now) {
                        const periodIteratorEnd = new Date(periodIteratorStart.getTime() + CHALLENGE_PERIOD_MS - 1);
                        if (periodIteratorEnd >= now) break;
                        let postedThisPeriod = false;
                        for (const postDate of postsForGeneralChallenge) {
                            if (postDate >= periodIteratorStart && postDate <= periodIteratorEnd) {
                                postedThisPeriod = true; break;
                            }
                        }
                        if (postedThisPeriod) successCount++; else failureCount++;
                        lastProcessed = periodIteratorEnd;
                        periodIteratorStart = new Date(lastProcessed.getTime() + 1);
                    }
                    writeOperations.challengeSuccessCount = successCount;
                    writeOperations.challengeFailureCount = failureCount;
                    if (lastProcessed) writeOperations.lastProcessedPeriodEndDate = lastProcessed.toISOString();
                    
                    finalSuccessCount = successCount;
                    finalFailureCount = failureCount;

                    // --- 현재 2주차 일반 챌린지 성공 여부 (isActive) 판정 ---
                    const currentPeriodSlotStart = new Date(epochStartDate.getTime() + Math.floor((now.getTime() - epochStartDate.getTime()) / CHALLENGE_PERIOD_MS) * CHALLENGE_PERIOD_MS);
                    let currentPeriodHasGeneralPost = false;
                    for (const postDate of postsForGeneralChallenge) {
                        if (postDate >= currentPeriodSlotStart && postDate <= now) {
                            currentPeriodHasGeneralPost = true; break;
                        }
                    }
                    finalIsActive = currentPeriodHasGeneralPost;
                    writeOperations.isActive = finalIsActive;

                    if (!blogData.lastProcessedPeriodEndDate &&
                        finalIsActive &&
                        successCount === 0 &&
                        failureCount === 0) {
                        writeOperations.challengeSuccessCount = 1;
                        finalSuccessCount = 1;
                        console.log(`[${blogName}] 첫 2주차 '일반 챌린지', 현재 기간 포스팅 확인되어 successCount=1 임시 설정`);
                    }
                }

                if (Object.keys(writeOperations).length > 0) {
                    await blogsRef.doc(blogId).update(writeOperations);
                    console.log(`[${blogName}] Firestore 업데이트. CP:${finalChallengePosts}, Special:${finalSpecialMissionCompleted}, Active:${finalIsActive}, S:${writeOperations.challengeSuccessCount !== undefined ? writeOperations.challengeSuccessCount : finalSuccessCount}, F:${writeOperations.challengeFailureCount !== undefined ? writeOperations.challengeFailureCount : finalFailureCount}`);
                } else {
                    console.log(`[${blogName}] 업데이트할 새로운 RSS 정보 없음.`);
                }
                successfulRssUpdates++;

            } catch (error) {
                console.error(`[${blogName}] RSS 처리 오류:`, error.message);
                failedRssUpdates++;
                try { await blogsRef.doc(blogId).update({ rssFetchError: error.message.substring(0, 200), lastRssFetchAttemptAt: admin.firestore.FieldValue.serverTimestamp() }); }
                catch (errInner) { console.error(`[${blogId}] Firestore 오류 기록 실패:`, errInner.message); }
            }
            blogsDataForRanking.push({ id: blogId, name: blogName, challengePosts: finalChallengePosts, isActive: finalIsActive, challengeSuccessCount: finalSuccessCount, challengeFailureCount: finalFailureCount, specialMissionCompleted: finalSpecialMissionCompleted });
        });

        await Promise.all(blogProcessingPromises);
        console.log('모든 블로그 RSS 피드 처리 완료.');

        console.log('블로그 순위 재계산 시작...');
        if (blogsDataForRanking.length > 0) {
            blogsDataForRanking.sort((a, b) => (b.challengePosts || 0) - (a.challengePosts || 0));
            const rankUpdatePromises = blogsDataForRanking.map((blog, index) => {
                const rank = index + 1;
                if (!blog.id) { console.error('Rank update: blog.id is undefined', blog); return Promise.resolve(); }
                return blogsRef.doc(blog.id).update({ rank: rank })
                    .catch(err => { console.error(`[${blog.id}] 순위 업데이트 실패:`, err.message); return Promise.resolve(); });
            });
            await Promise.all(rankUpdatePromises);
            console.log('블로그 순위 재계산 및 업데이트 완료.');
        } else { console.log('순위를 계산할 블로그 데이터가 없습니다.'); }

        const finalResponseObject = {
            message: `모든 업데이트 완료. RSS 성공: ${successfulRssUpdates}, RSS 실패: ${failedRssUpdates}`,
            updatedCount: successfulRssUpdates,
            errorCount: failedRssUpdates
        };
        console.log('Sending final success response object:', JSON.stringify(finalResponseObject, null, 2));
        return res.status(200).json(finalResponseObject);

    } catch (finalError) {
        console.error('전체 RSS 업데이트 프로세스 중 심각한 오류 발생:', finalError);
        const errorResponseObject = {
            error: '전체 RSS 업데이트 프로세스 중 심각한 오류 발생',
            details: String(finalError.message),
            updatedCount: successfulRssUpdates,
            errorCount: failedRssUpdates
        };
        console.log('Sending final error response object:', JSON.stringify(errorResponseObject, null, 2));
        return res.status(500).json(errorResponseObject);
    }
};